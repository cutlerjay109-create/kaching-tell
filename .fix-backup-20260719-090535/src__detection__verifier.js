const { EventEmitter } = require('events');
const { VERIFICATION_TIMEOUT } = require('../config/constants');
const { parseScore } = require('../utils/score');
const logger = require('../utils/logger');

// Official stat confirmations arrive ~54s after the goal action. Cap the pairing
// window so an orphan VAR/disallowed goal action can't "steal" a later real goal's
// increment. Anything older than this with no increment is a false positive.
const MAX_LAG_MS = 150000;

// Verifies detections against the official stat feed.
//
// Model: goal actions and stat increments arrive in the SAME order. The Nth goal
// action is confirmed by the Nth stat increment (FIFO). The scoring side is read
// from WHICH stat key increments on that event - not from the goal action's
// Participant field (which was unreliable). Detections that never get a matching
// increment are false positives (VAR/disallowed goals).
class Verifier extends EventEmitter {
  constructor() {
    super();
    this.pendingByFixture = new Map(); // fixtureId -> [entry] ordered by goalEventTs
    this.confirmed = new Map();        // fixtureId -> { home, away } last confirmed stat values
  }

  seedBaseline(fixtureId, totalGoals, homeGoals, awayGoals) {
    this.confirmed.set(fixtureId, { home: homeGoals || 0, away: awayGoals || 0 });
    logger.info('verifier', 'Baseline seeded', { fixtureId, homeGoals, awayGoals });
  }

  watch(detection) {
    const fid = detection.fixtureId;
    if (!this.pendingByFixture.has(fid)) this.pendingByFixture.set(fid, []);
    const arr = this.pendingByFixture.get(fid);

    const entry = { detection, goalEventTs: detection.eventTs, startedAt: Date.now() };
    entry.timer = setTimeout(() => {
      const idx = arr.indexOf(entry);
      if (idx !== -1) {
        arr.splice(idx, 1);
        logger.warn('verifier', 'Timeout - false positive', { fixtureId: fid });
        this.emit('result', {
          ...detection,
          status: 'false_positive',
          leadTimeMs: null,
          fpReason: 'No official stat increment within 5 min - likely VAR/disallowed goal'
        });
      }
    }, VERIFICATION_TIMEOUT);

    arr.push(entry);
    arr.sort((a, b) => a.goalEventTs - b.goalEventTs); // keep FIFO by goal time
    logger.info('verifier', 'Watching', { fixtureId: fid, pending: arr.length });
  }

  onScoreEvent(event) {
    if (!event.FixtureId) return;
    const parsed = parseScore(event);
    if (!parsed.hasStats) return;

    const fid = event.FixtureId;
    const prev = this.confirmed.get(fid) || { home: 0, away: 0 };

    // Never go backwards (guards against corrupted batch events)
    const newHome = Math.max(parsed.home, prev.home);
    const newAway = Math.max(parsed.away, prev.away);
    const dHome = newHome - prev.home;
    const dAway = newAway - prev.away;
    if (dHome === 0 && dAway === 0) return;

    this.confirmed.set(fid, { home: newHome, away: newAway });
    logger.info('verifier', 'Stat increment', { fixtureId: fid, home: newHome, away: newAway });

    const incTs = event.Ts || Date.now();
    const arr = this.pendingByFixture.get(fid) || [];

    // Expand into per-goal increments (home first, then away for rare same-event case)
    const increments = [];
    for (let i = 0; i < dHome; i++) increments.push('home');
    for (let i = 0; i < dAway; i++) increments.push('away');

    let runHome = prev.home;
    let runAway = prev.away;
    for (const side of increments) {
      if (side === 'home') runHome++; else runAway++;

      // Confirm the oldest pending detection whose goal happened before this increment
      const idx = arr.findIndex(e => e.goalEventTs <= incTs && (incTs - e.goalEventTs) <= MAX_LAG_MS);
      if (idx === -1) break; // increment with no eligible detection waiting - ignore
      const entry = arr.splice(idx, 1)[0];
      clearTimeout(entry.timer);

      let leadTimeMs = entry.goalEventTs ? (incTs - entry.goalEventTs) : (Date.now() - entry.startedAt);
      if (!(leadTimeMs > 0)) leadTimeMs = Date.now() - entry.startedAt;

      const confirmedScoringTeam = side === 'home'
        ? entry.detection.participant1
        : entry.detection.participant2;
      const confirmedScore = runHome + ' - ' + runAway;

      logger.info('verifier', 'VERIFIED', { fixtureId: fid, confirmedScoringTeam, confirmedScore, leadMs: leadTimeMs });
      this.emit('result', {
        ...entry.detection,
        status: 'verified',
        leadTimeMs,
        confirmedScoringTeam,
        confirmedScore,
        scoreAtDetection: confirmedScore
      });
    }
  }

  // Mark any detection that never matched a stat increment as a false positive.
  // Call at end of a replay; in live, the per-detection timeout handles this.
  finalize() {
    for (const [fid, arr] of this.pendingByFixture) {
      for (const entry of arr) {
        clearTimeout(entry.timer);
        logger.warn('verifier', 'Unmatched at finalize - false positive', { fixtureId: fid });
        this.emit('result', {
          ...entry.detection,
          status: 'false_positive',
          leadTimeMs: null,
          fpReason: entry.detection.fpReason || 'No official stat increment matched - likely VAR/disallowed goal'
        });
      }
      arr.length = 0;
    }
  }
}

module.exports = { Verifier };
