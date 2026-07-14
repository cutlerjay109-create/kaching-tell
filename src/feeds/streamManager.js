require('dotenv').config();
const { EventSource } = require('eventsource');
const { fetchActiveFixtures } = require('./fixturePoller');
const logger = require('../utils/logger');

class StreamManager {
  constructor(onScore, onOdds) {
    this.onScore = onScore;
    this.onOdds = onOdds;
    this.fixtures = [];
    this.fixtureIds = new Set();
    this.scoreSource = null;
    this.oddsSource = null;
    this.running = false;
    this.seenScores = new Set();
    this.seenOdds = new Set();
  }

  async start() {
    this.fixtures = await fetchActiveFixtures();
    if (!this.fixtures.length) {
      logger.warn('streamManager', 'No active World Cup fixtures found');
      return [];
    }
    this.fixtures.forEach(f => this.fixtureIds.add(f.FixtureId));
    logger.info('streamManager', 'Connecting to SSE streams for ' + this.fixtures.length + ' fixtures');
    this.running = true;
    this._connectScores();
    this._connectOdds();
    return this.fixtures;
  }

  _connectScores() {
    if (!this.running) return;
    const url = process.env.TXLINE_API_ORIGIN + '/api/scores/stream';
    logger.info('streamManager', 'Connecting to scores SSE stream');

    this.scoreSource = new EventSource(url, {
      fetch: (input, init) => fetch(input, {
        ...init,
        headers: {
          ...init.headers,
          'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
          'X-Api-Token': process.env.TXLINE_API_TOKEN,
        }
      })
    });

    this.scoreSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data.FixtureId) {
          logger.debug('streamManager', 'Score event no FixtureId', { raw: e.data.substring(0,100) });
          return;
        }
        logger.info('streamManager', 'Score event received', { fixtureId: data.FixtureId, action: data.Action, inSet: this.fixtureIds.has(data.FixtureId) });
        if (!this.fixtureIds.has(data.FixtureId)) return;

        const key = data.FixtureId + ':' + data.Seq + ':' + data.Ts;
        if (this.seenScores.has(key)) return;
        this.seenScores.add(key);

        this.onScore(data);
      } catch(e) { logger.error('streamManager', 'Score parse error', { err: e.message }); }
    };

    this.scoreSource.onerror = (err) => {
      logger.warn('streamManager', 'Scores SSE error', { status: err.status, message: err.message, type: err.type });
      this.scoreSource.close();
      setTimeout(() => { if (this.running) this._connectScores(); }, 5000);
    };

    this.scoreSource.addEventListener('heartbeat', (e) => {
      logger.debug('streamManager', 'Score stream heartbeat');
    });
  }

  _connectOdds() {
    if (!this.running) return;
    const url = process.env.TXLINE_API_ORIGIN + '/api/odds/stream';
    logger.info('streamManager', 'Connecting to odds SSE stream');

    this.oddsSource = new EventSource(url, {
      fetch: (input, init) => fetch(input, {
        ...init,
        headers: {
          ...init.headers,
          'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
          'X-Api-Token': process.env.TXLINE_API_TOKEN,
        }
      })
    });

    this.oddsSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data.FixtureId) return;
        logger.info('streamManager', 'Odds event received', { fixtureId: data.FixtureId, inRunning: data.InRunning, inSet: this.fixtureIds.has(data.FixtureId) });
        if (!this.fixtureIds.has(data.FixtureId)) return;
        if (!data.InRunning) return;
        if (!data.Prices || data.Prices.length === 0) return;

        const key = data.FixtureId + ':' + data.MessageId;
        if (this.seenOdds.has(key)) return;
        this.seenOdds.add(key);

        this.onOdds(data);
      } catch(e) { logger.error('streamManager', 'Odds parse error', { err: e.message }); }
    };

    this.oddsSource.onerror = (err) => {
      logger.warn('streamManager', 'Odds SSE error', { status: err.status, message: err.message, type: err.type });
      this.oddsSource.close();
      setTimeout(() => { if (this.running) this._connectOdds(); }, 5000);
    };

    this.oddsSource.addEventListener('heartbeat', (e) => {
      logger.debug('streamManager', 'Odds stream heartbeat');
    });
  }

  stop() {
    this.running = false;
    if (this.scoreSource) this.scoreSource.close();
    if (this.oddsSource) this.oddsSource.close();
    logger.info('streamManager', 'SSE streams closed');
  }

  getFixtures() { return this.fixtures; }
}

module.exports = { StreamManager };
