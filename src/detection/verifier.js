const { EventEmitter } = require('events');
const { VERIFICATION_TIMEOUT } = require('../config/constants');
const logger = require('../utils/logger');

class Verifier extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
    this.baselines = new Map(); // fixtureId -> { totalGoals, homeGoals, awayGoals }
  }

  seedBaseline(fixtureId, totalGoals, homeGoals, awayGoals) {
    this.baselines.set(fixtureId, { totalGoals, homeGoals, awayGoals });
    logger.info('verifier', 'Baseline seeded', { fixtureId, totalGoals, homeGoals, awayGoals });
  }

  watch(detection) {
    const key = detection.fixtureId + ':' + detection.wallTs;

    // Use seeded baseline if available, otherwise use detection stats
    const baseline = this.baselines.get(detection.fixtureId);
    const prevGoals = baseline ? baseline.totalGoals : (detection.currentStats['1'] || 0);
    const prevHome = baseline ? baseline.homeGoals : (detection.currentStats['1001'] || 0);
    const prevAway = baseline ? baseline.awayGoals : (detection.currentStats['1002'] || 0);

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
    logger.info('verifier', 'Watching for confirmation', { key, prevGoals, prevHome, prevAway });
  }

  onScoreEvent(event) {
    if (!event.Stats) return;
    const currentGoals = event.Stats['1'] || 0;
    const currentHome = event.Stats['1001'] || 0;
    const currentAway = event.Stats['1002'] || 0;

    // Update baselines
    const existing = this.baselines.get(event.FixtureId) || { totalGoals: 0, homeGoals: 0, awayGoals: 0 };
    if (currentGoals > existing.totalGoals) {
      this.baselines.set(event.FixtureId, { totalGoals: currentGoals, homeGoals: currentHome, awayGoals: currentAway });
    }

    this.pending.forEach((entry, key) => {
      if (entry.detection.fixtureId !== event.FixtureId) return;
      if (currentGoals > entry.prevGoals) {
        clearTimeout(entry.timer);
        this.pending.delete(key);
        const leadTimeMs = Date.now() - entry.startedAt;

        let confirmedScoringTeam = entry.detection.scoringTeam;
        let confirmedScore = entry.detection.scoreAtDetection;

        if (currentHome > entry.prevHome) {
          confirmedScoringTeam = entry.detection.participant1;
          confirmedScore = currentHome + ' - ' + currentAway;
        } else if (currentAway > entry.prevAway) {
          confirmedScoringTeam = entry.detection.participant2;
          confirmedScore = currentHome + ' - ' + currentAway;
        }

        logger.info('verifier', 'VERIFIED', { key, leadTimeMs, confirmedScoringTeam, confirmedScore });

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

        // Update baseline after verification
        this.baselines.set(event.FixtureId, { totalGoals: currentGoals, homeGoals: currentHome, awayGoals: currentAway });
      }
    });
  }
}

module.exports = { Verifier };
