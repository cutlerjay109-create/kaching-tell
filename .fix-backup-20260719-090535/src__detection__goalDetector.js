const { EventEmitter } = require('events');
const { isSane } = require('./clockSanity');
const { BaselineCalculator } = require('./baselineCalculator');
const { SpikeDetector } = require('./spikeDetector');
const { parseScore } = require('../utils/score');
const logger = require('../utils/logger');

const GOAL_WINDOW = 15000;      // spike must land within 15s of the goal action
const GRACE_MS = 6000;          // wait up to 6s (event-time) for a spike before firing LOW
const SPIKE_RETENTION = 30000;  // keep spikes 30s for matching
// Cooldown only suppresses the SAME goal's repeated/echoed goal actions.
// 120s was swallowing legitimate second goals; 30s dedups one goal's burst.
const COOLDOWN_EVENT_MS = 30000;

class GoalDetector extends EventEmitter {
  constructor(fixture) {
    super();
    this.fixture = fixture;
    this.baseline = new BaselineCalculator();
    this.spike = new SpikeDetector(this.baseline);
    this.pendingGoals = [];   // queue — NOT a single slot (fixes lost goals in bursts)
    this.recentSpikes = [];   // buffered spikes with their event time
    this.lastEventTs = 0;     // max event time seen — drives resolution deterministically
    this.lastDetectionEventTs = 0;
    this.discardedCount = 0;
    this.lastDiscardLog = 0;
    this._lastWallTs = 0; // ensures every detection gets a unique wallTs (ledger key)

    // Score tracking
    this.homeGoals = 0;
    this.awayGoals = 0;
    this.lastMarketType = null;
  }

  onScoreEvent(event) {
    if (!isSane(event, this.fixture.StartTime)) {
      this.discardedCount++;
      const now = Date.now();
      if (now - this.lastDiscardLog > 10000) {
        logger.warn('goalDetector', 'Insane clock events discarded', {
          fixtureId: event.FixtureId,
          count: this.discardedCount
        });
        this.discardedCount = 0;
        this.lastDiscardLog = now;
      }
      return;
    }

    // Update running score from ALL score events — never go backwards.
    // Uses the shared parser so detector and verifier read score identically.
    const parsed = parseScore(event);
    if (parsed.hasStats) {
      if (parsed.home > this.homeGoals) this.homeGoals = parsed.home;
      if (parsed.away > this.awayGoals) this.awayGoals = parsed.away;
    }

    const eventTs = event.Ts || Date.now();
    if (eventTs > this.lastEventTs) this.lastEventTs = eventTs;

    if (event.Action === 'goal') {
      if (this.lastDetectionEventTs && (eventTs - this.lastDetectionEventTs) < COOLDOWN_EVENT_MS) {
        logger.debug('goalDetector', 'Goal action ignored — cooldown active', {
          fixtureId: event.FixtureId,
          remainingMs: COOLDOWN_EVENT_MS - (eventTs - this.lastDetectionEventTs)
        });
        return;
      }
      // Dedup the same goal's echoed actions immediately on accept.
      this.lastDetectionEventTs = eventTs;

      const scoringParticipant = event.Participant;
      const isHomeGoal = scoringParticipant === 1 || scoringParticipant === '1';
      const scoringTeam = isHomeGoal ? this.fixture.Participant1 : this.fixture.Participant2;
      const goalType = (event.Data && event.Data.GoalType) ? event.Data.GoalType : 'Unknown';

      logger.info('goalDetector', 'goal action received', {
        fixtureId: event.FixtureId,
        clock: event.Clock ? event.Clock.Seconds : null,
        scoringTeam, goalType, eventTs
      });

      this.pendingGoals.push({
        event, eventTs, scoringTeam, goalType, isHomeGoal,
        homeGoalsAtDetection: this.homeGoals,
        awayGoalsAtDetection: this.awayGoals
      });
    }

    if (event.Action === 'game_finalised') {
      this.flush();
      this.emit('matchFinished', this.fixture.FixtureId);
      return;
    }

    this._resolve();
  }

  onOddsEvent(event) {
    if (!event.Prices || event.Prices.length === 0) return;
    this.lastMarketType = event.SuperOddsType;
    const eventTs = event.Ts || Date.now();
    if (eventTs > this.lastEventTs) this.lastEventTs = eventTs;
    this.baseline.update(event);
    const spike = this.spike.update(event);
    if (spike) {
      this.recentSpikes.push({ spike, eventTs, marketType: event.SuperOddsType });
    }
    this._resolve();
  }

  // Resolve pending goals by event time: match a spike if one is near, otherwise
  // fire LOW once the grace window has passed. Never overwrites/loses a goal.
  _resolve(force = false) {
    // Prune stale spikes
    const cutoff = this.lastEventTs - SPIKE_RETENTION;
    if (this.recentSpikes.length) {
      this.recentSpikes = this.recentSpikes.filter(s => s.eventTs >= cutoff);
    }

    const still = [];
    for (const pg of this.pendingGoals) {
      const match = this._nearestSpike(pg.eventTs);
      if (match) {
        this._fire(pg, match);
      } else if (force || (this.lastEventTs - pg.eventTs) >= GRACE_MS) {
        this._fire(pg, null); // no spike — LOW confidence, score-only
      } else {
        still.push(pg); // keep waiting for a possible spike
      }
    }
    this.pendingGoals = still;
  }

  _nearestSpike(goalTs) {
    let best = null, bestDist = Infinity;
    for (const s of this.recentSpikes) {
      const dist = Math.abs(s.eventTs - goalTs);
      if (dist <= GOAL_WINDOW && dist < bestDist) { best = s; bestDist = dist; }
    }
    return best;
  }

  // Fire any goals still pending (match end / end of replay).
  flush() {
    this._resolve(true);
  }

  _fire(pa, spikeEntry) {
    const event = pa.event;
    const clockSeconds = event.Clock ? event.Clock.Seconds : 0;
    const clockMins = Math.floor(clockSeconds / 60);
    const clockSecs = clockSeconds % 60;
    const clockFormatted = clockMins + ':' + String(clockSecs).padStart(2, '0');

    const scoreDisplay = pa.homeGoalsAtDetection + ' - ' + pa.awayGoalsAtDetection;
    const spike = spikeEntry ? spikeEntry.spike : null;

    // Unique, monotonic wallTs — this is the ledger key. If two detections fire in
    // the same millisecond (fast replay), a plain Date.now() would collide and
    // verification results would patch the wrong record.
    let wallTs = Date.now();
    if (wallTs <= this._lastWallTs) wallTs = this._lastWallTs + 1;
    this._lastWallTs = wallTs;

    const detection = {
      fixtureId: this.fixture.FixtureId,
      matchName: this.fixture.Participant1 + ' vs ' + this.fixture.Participant2,
      participant1: this.fixture.Participant1,
      participant2: this.fixture.Participant2,
      scoringTeam: pa.scoringTeam,
      isHomeGoal: pa.isHomeGoal,
      goalType: pa.goalType,
      matchClock: clockSeconds,
      matchClockFormatted: clockFormatted,
      scoreAtDetection: scoreDisplay,
      homeGoals: pa.homeGoalsAtDetection,
      awayGoals: pa.awayGoalsAtDetection,
      wallTs: wallTs,
      eventTs: pa.eventTs,
      spikeMagnitude: spike ? spike.magnitude : 0,
      spikeRatio: spike ? spike.ratio : '0.00',
      baseline: spike ? spike.baseline : 0,
      marketType: spikeEntry ? spikeEntry.marketType : 'SCORE_ONLY',
      confidence: this._confidence(spike),
      currentStats: event.Stats || {},
      // Verifier decides verified vs false-positive after watching for the stat increment.
      fpReason: null,
      status: 'pending'
    };

    logger.info('goalDetector', 'DETECTION FIRED', {
      fixtureId: detection.fixtureId,
      scoringTeam: detection.scoringTeam,
      clock: detection.matchClockFormatted,
      score: detection.scoreAtDetection,
      confidence: detection.confidence,
      market: detection.marketType
    });

    // Consume the matched spike so it can't double-fire another goal.
    if (spikeEntry) {
      this.recentSpikes = this.recentSpikes.filter(s => s !== spikeEntry);
    }
    this.emit('detection', detection);
  }

  _confidence(spike) {
    if (!spike) return 'LOW';
    if (spike.ratio >= 10 && spike.magnitude >= 5000) return 'HIGH';
    if (spike.ratio >= 5  && spike.magnitude >= 2000) return 'MEDIUM';
    return 'LOW';
  }
}

module.exports = { GoalDetector };
