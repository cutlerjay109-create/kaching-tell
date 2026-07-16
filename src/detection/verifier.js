const { EventEmitter } = require('events');
const { VERIFICATION_TIMEOUT } = require('../config/constants');
const logger = require('../utils/logger');

class Verifier extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
    this.currentGoals = new Map(); // fixtureId -> { total, home, away }
  }

  seedBaseline(fixtureId, totalGoals, homeGoals, awayGoals) {
    this.currentGoals.set(fixtureId, { total: totalGoals, home: homeGoals, away: awayGoals });
    logger.info('verifier', 'Baseline seeded', { fixtureId, totalGoals, homeGoals, awayGoals });
  }

  watch(detection) {
    const key = detection.fixtureId + ':' + detection.wallTs;

    // Get current known goal count for this fixture
    const current = this.currentGoals.get(detection.fixtureId) || { total: 0, home: 0, away: 0 };
    const prevGoals = current.total;
    const prevHome = current.home;
    const prevAway = current.away;

    const timer = setTimeout(() => {
      if (this.pending.has(key)) {
        this.pending.delete(key);
        logger.warn('verifier', 'Timeout — false positive', { key });
        this.emit('result', {
          ...detection,
          status: 'false_positive',
          leadTimeMs: null,
          fpReason: detection.fpReason || 'No stat increment within 5 minutes'
        });
      }
    }, VERIFICATION_TIMEOUT);

    this.pending.set(key, { detection, prevGoals, prevHome, prevAway, timer, startedAt: Date.now() });
    logger.info('verifier', 'Watching', { key, prevGoals, prevHome, prevAway });
  }

  onScoreEvent(event) {
    if (!event.Stats || !event.FixtureId) return;

    // Check ALL possible stat keys TxLINE uses
    const total1 = event.Stats['1'] || 0;
    const home1001 = event.Stats['1001'] || 0;
    const away1002 = event.Stats['1002'] || 0;

    // Also check if Stats object has any numeric keys with goal data
    const statKeys = Object.keys(event.Stats);
    let detectedTotal = total1;
    let detectedHome = home1001;
    let detectedAway = away1002;

    // If primary keys are 0, try to find goal data in other stat keys
    if (detectedTotal === 0 && statKeys.length > 0) {
      // Try common alternative keys
      detectedHome = event.Stats['1001'] || event.Stats['101'] || event.Stats['home'] || 0;
      detectedAway = event.Stats['1002'] || event.Stats['102'] || event.Stats['away'] || 0;
      detectedTotal = detectedHome + detectedAway;
    }

    // Update our running goal tracker
    const existing = this.currentGoals.get(event.FixtureId) || { total: 0, home: 0, away: 0 };

    // Only update if stats show MORE goals (never go backwards)
    const newTotal = Math.max(detectedTotal, existing.total);
    const newHome = Math.max(detectedHome, existing.home);
    const newAway = Math.max(detectedAway, existing.away);

    if (newTotal > existing.total || newHome > existing.home || newAway > existing.away) {
      this.currentGoals.set(event.FixtureId, { total: newTotal, home: newHome, away: newAway });
      logger.info('verifier', 'Score updated', { fixtureId: event.FixtureId, home: newHome, away: newAway, total: newTotal });
    }

    // Check if any pending detections can be verified
    this.pending.forEach((entry, key) => {
      if (entry.detection.fixtureId !== event.FixtureId) return;

      const goalIncremented = newTotal > entry.prevGoals || newHome > entry.prevHome || newAway > entry.prevAway;

      if (goalIncremented) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        const leadTimeMs = Date.now() - entry.startedAt;

        let confirmedScoringTeam = entry.detection.scoringTeam;
        let confirmedScore = newHome + ' - ' + newAway;

        if (newHome > entry.prevHome) {
          confirmedScoringTeam = entry.detection.participant1;
        } else if (newAway > entry.prevAway) {
          confirmedScoringTeam = entry.detection.participant2;
        }

        logger.info('verifier', 'VERIFIED', { key, leadTimeMs, confirmedScoringTeam, confirmedScore });

        this.emit('result', {
          ...entry.detection,
          status: 'verified',
          leadTimeMs,
          confirmedScoringTeam,
          confirmedScore,
          scoreAtDetection: confirmedScore
        });

        // Update baseline after verification
        this.currentGoals.set(event.FixtureId, { total: newTotal, home: newHome, away: newAway });
      }
    });
  }
}

module.exports = { Verifier };
