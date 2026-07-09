const { EventEmitter } = require('events');
const { VERIFICATION_TIMEOUT } = require('../config/constants');
const logger = require('../utils/logger');

class Verifier extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
  }

  watch(detection) {
    const key = detection.fixtureId + ':' + detection.wallTs;
    const prevGoals = detection.currentStats['1'] || 0;
    const prevHome = detection.currentStats['1001'] || 0;
    const prevAway = detection.currentStats['1002'] || 0;

    const timer = setTimeout(() => {
      if (this.pending.has(key)) {
        this.pending.delete(key);
        logger.warn('verifier', 'Timeout — false positive', {
          key,
          reason: 'No stat increment within 5 minutes'
        });
        this.emit('result', {
          ...detection,
          status: 'false_positive',
          leadTimeMs: null,
          fpReason: detection.fpReason || 'No stat increment within 5 minutes — likely VAR or disallowed goal'
        });
      }
    }, VERIFICATION_TIMEOUT);

    this.pending.set(key, {
      detection,
      prevGoals,
      prevHome,
      prevAway,
      timer,
      startedAt: Date.now()
    });

    logger.info('verifier', 'Watching for confirmation', {
      key,
      prevGoals,
      prevHome,
      prevAway
    });
  }

  onScoreEvent(event) {
    if (!event.Stats) return;

    const currentGoals = event.Stats['1'] || 0;
    const currentHome = event.Stats['1001'] || 0;
    const currentAway = event.Stats['1002'] || 0;

    this.pending.forEach((entry, key) => {
      if (entry.detection.fixtureId !== event.FixtureId) return;

      if (currentGoals > entry.prevGoals) {
        clearTimeout(entry.timer);
        this.pending.delete(key);

        const leadTimeMs = Date.now() - entry.startedAt;

        // Determine which team actually scored from stat increment
        let confirmedScoringTeam = entry.detection.scoringTeam;
        let confirmedScore = entry.detection.scoreAtDetection;

        if (currentHome > entry.prevHome) {
          confirmedScoringTeam = entry.detection.participant1;
          confirmedScore = currentHome + ' - ' + currentAway;
        } else if (currentAway > entry.prevAway) {
          confirmedScoringTeam = entry.detection.participant2;
          confirmedScore = currentHome + ' - ' + currentAway;
        }

        logger.info('verifier', 'VERIFIED', {
          key,
          leadTimeMs,
          confirmedScoringTeam,
          confirmedScore
        });

        this.emit('result', {
          ...entry.detection,
          status: 'verified',
          leadTimeMs,
          confirmedGoals: currentGoals,
          confirmedHome: currentHome,
          confirmedAway: currentAway,
          confirmedScoringTeam,
          confirmedScore,
          scoreAtDetection: confirmedScore
        });
      }
    });
  }
}

module.exports = { Verifier };
