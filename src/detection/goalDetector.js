const { EventEmitter } = require('events');
const { isSane } = require('./clockSanity');
const { BaselineCalculator } = require('./baselineCalculator');
const { SpikeDetector } = require('./spikeDetector');
const logger = require('../utils/logger');

const GOAL_WINDOW = 15000;
const COOLDOWN_EVENT_MS = 120000;

class GoalDetector extends EventEmitter {
  constructor(fixture) {
    super();
    this.fixture = fixture;
    this.baseline = new BaselineCalculator();
    this.spike = new SpikeDetector(this.baseline);
    this.pendingGoalAction = null;
    this.lastSpike = null;
    this.lastDetectionEventTs = 0;
    this.discardedCount = 0;
    this.lastDiscardLog = 0;

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

    // Update running score from stats
    if (event.Stats && Object.keys(event.Stats).length > 0) {
      const p1Goals = event.Stats['1001'] || 0;
      const p2Goals = event.Stats['1002'] || 0;
      if (p1Goals !== this.homeGoals || p2Goals !== this.awayGoals) {
        this.homeGoals = p1Goals;
        this.awayGoals = p2Goals;
      }
    }

    if (event.Action === 'goal') {
      const eventTs = event.Ts || Date.now();

      if (this.lastDetectionEventTs && (eventTs - this.lastDetectionEventTs) < COOLDOWN_EVENT_MS) {
        logger.debug('goalDetector', 'Goal action ignored — cooldown active', {
          fixtureId: event.FixtureId,
          remainingMs: COOLDOWN_EVENT_MS - (eventTs - this.lastDetectionEventTs)
        });
        return;
      }

      // Determine which team scored
      const scoringParticipant = event.Participant || null;
      const isHomeGoal = scoringParticipant === 1 || scoringParticipant === '1';
      const scoringTeam = isHomeGoal ? this.fixture.Participant1 : this.fixture.Participant2;
      const goalType = (event.Data && event.Data.GoalType) ? event.Data.GoalType : 'Unknown';

      // Determine if this is a real goal or VAR (Stats empty = likely VAR/pre-confirmation)
      const hasStatConfirmation = event.Stats && Object.keys(event.Stats).length > 0;

      logger.info('goalDetector', 'goal action received', {
        fixtureId: event.FixtureId,
        clock: event.Clock ? event.Clock.Seconds : null,
        scoringTeam,
        goalType,
        hasStatConfirmation,
        eventTs
      });

      this.pendingGoalAction = {
        event,
        receivedAt: Date.now(),
        eventTs,
        scoringTeam,
        goalType,
        isHomeGoal,
        hasStatConfirmation,
        homeGoalsAtDetection: this.homeGoals,
        awayGoalsAtDetection: this.awayGoals
      };
      this._tryConfirm();
    }

    if (event.Action === 'game_finalised') {
      this.emit('matchFinished', this.fixture.FixtureId);
    }
  }

  onOddsEvent(event) {
    if (!event.Prices || event.Prices.length === 0) return;
    this.lastMarketType = event.SuperOddsType;
    this.baseline.update(event);
    const spike = this.spike.update(event);
    if (spike) {
      this.lastSpike = { spike, ts: Date.now(), marketType: event.SuperOddsType };
      this._tryConfirm();
    }
  }

  _tryConfirm() {
    if (!this.pendingGoalAction) return;

    // If we have an odds spike within window — HIGH/MEDIUM confidence
    // If no odds spike — still fire with LOW confidence after 5 seconds
    const hasSpike = this.lastSpike && Math.abs(this.pendingGoalAction.receivedAt - this.lastSpike.ts) <= GOAL_WINDOW;
    const waitedLongEnough = (Date.now() - this.pendingGoalAction.receivedAt) >= 5000;

    if (!hasSpike && !waitedLongEnough) {
      // Wait up to 5 seconds for an odds spike to confirm
      setTimeout(() => this._tryConfirm(), 5000);
      return;
    }

    const pa = this.pendingGoalAction;
    const event = pa.event;

    // Format clock as MM:SS
    const clockSeconds = event.Clock ? event.Clock.Seconds : 0;
    const clockMins = Math.floor(clockSeconds / 60);
    const clockSecs = clockSeconds % 60;
    const clockFormatted = clockMins + ':' + String(clockSecs).padStart(2, '0');

    // Score at time of detection
    const homeScore = pa.homeGoalsAtDetection;
    const awayScore = pa.awayGoalsAtDetection;
    const scoreDisplay = homeScore + ' - ' + awayScore;

    // False positive reason
    const fpReason = !pa.hasStatConfirmation ? 'VAR/Pre-confirmation — Stats empty at detection time' : null;

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
      homeGoals: homeScore,
      awayGoals: awayScore,
      wallTs: Date.now(),
      eventTs: pa.eventTs,
      spikeMagnitude: this.lastSpike ? this.lastSpike.spike.magnitude : 0,
      spikeRatio: this.lastSpike ? this.lastSpike.spike.ratio : '0.00',
      baseline: this.lastSpike ? this.lastSpike.spike.baseline : 0,
      marketType: this.lastSpike ? this.lastSpike.marketType : 'SCORE_ONLY',
      confidence: this._confidence(this.lastSpike ? this.lastSpike.spike : null),
      currentStats: event.Stats || {},
      fpReason,
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

    this.lastDetectionEventTs = pa.eventTs;
    this.pendingGoalAction = null;
    this.lastSpike = null;
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
