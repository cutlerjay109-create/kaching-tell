const { fetchActiveFixtures } = require('./fixturePoller');
const { fetchScoreSlot, getCurrentSlot } = require('./scoreStream');
const { fetchOddsSlot } = require('./oddsStream');
const { POLL_INTERVAL } = require('../config/constants');
const logger = require('../utils/logger');

class StreamManager {
  constructor(onScore, onOdds) {
    this.onScore = onScore;
    this.onOdds = onOdds;
    this.fixtures = [];
    this.fixtureIds = new Set();
    this.seenScores = new Set();
    this.seenOdds = new Set();
    this.timer = null;
    this.running = false;
  }

  async start() {
    this.fixtures = await fetchActiveFixtures();
    if (!this.fixtures.length) {
      logger.warn('streamManager', 'No active World Cup fixtures found');
      return [];
    }
    this.fixtures.forEach(f => this.fixtureIds.add(f.FixtureId));
    logger.info('streamManager', 'Monitoring ' + this.fixtures.length + ' fixtures');
    this.running = true;
    this._poll();
    this.timer = setInterval(() => this._poll(), POLL_INTERVAL);
    return this.fixtures;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    logger.info('streamManager', 'Stopped');
  }

  async _poll() {
    if (!this.running) return;
    const slot = getCurrentSlot();
    const [scores, odds] = await Promise.all([
      fetchScoreSlot(slot.epochDay, slot.hourOfDay, slot.interval),
      fetchOddsSlot(slot.epochDay, slot.hourOfDay, slot.interval)
    ]);

    scores
      .filter(s => this.fixtureIds.has(s.FixtureId))
      .forEach(s => {
        const key = s.FixtureId + ':' + s.Seq + ':' + s.Ts;
        if (!this.seenScores.has(key)) {
          this.seenScores.add(key);
          this.onScore(s);
        }
      });

    odds
      .filter(o => this.fixtureIds.has(o.FixtureId) && o.InRunning && o.Prices && o.Prices.length > 0)
      .forEach(o => {
        const key = o.FixtureId + ':' + o.MessageId;
        if (!this.seenOdds.has(key)) {
          this.seenOdds.add(key);
          this.onOdds(o);
        }
      });
  }

  getFixtures() { return this.fixtures; }
}

module.exports = { StreamManager };
