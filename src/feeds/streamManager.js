require('dotenv').config();
const { EventSource } = require('eventsource');
const axios = require('axios');
const { fetchActiveFixtures } = require('./fixturePoller');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 15000
});

function getCurrentSlots() {
  const now = new Date();
  const epochDay = Math.floor(Date.now() / 86400000);
  const hourOfDay = now.getUTCHours();
  const interval = Math.floor(now.getUTCMinutes() / 10);
  const slots = [];
  for (let back = 0; back <= 2; back++) {
    let d = epochDay, h = hourOfDay, i = interval - back;
    if (i < 0) { i += 6; h -= 1; if (h < 0) { h += 24; d -= 1; } }
    slots.push({ d, h, i });
  }
  return slots;
}

async function safeFetch(url) {
  try { return (await client.get(url)).data || []; } catch(e) { return []; }
}

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
    this.pollTimer = null;
  }

  async start() {
    this.fixtures = await fetchActiveFixtures();
    if (!this.fixtures.length) {
      logger.warn('streamManager', 'No active World Cup fixtures found');
      return [];
    }
    this.fixtures.forEach(f => this.fixtureIds.add(f.FixtureId));
    logger.info('streamManager', 'Monitoring ' + this.fixtures.length + ' fixtures', { ids: [...this.fixtureIds] });
    this.running = true;
    this._connectScores();
    this._connectOdds();
    this._startPolling();
    return this.fixtures;
  }

  _sseOptions() {
    return {
      fetch: (input, init) => fetch(input, {
        ...init,
        headers: {
          ...init.headers,
          'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
          'X-Api-Token': process.env.TXLINE_API_TOKEN,
        }
      })
    };
  }

  _connectScores() {
    if (!this.running) return;
    const url = process.env.TXLINE_API_ORIGIN + '/api/scores/stream';
    logger.info('streamManager', 'Connecting scores SSE');
    this.scoreSource = new EventSource(url, this._sseOptions());
    this.scoreSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data.FixtureId || !this.fixtureIds.has(data.FixtureId)) return;
        const key = data.FixtureId + ':' + data.Seq + ':' + data.Ts;
        if (this.seenScores.has(key)) return;
        this.seenScores.add(key);
        logger.info('streamManager', 'SSE score event', { fixtureId: data.FixtureId, action: data.Action });
        this.onScore(data);
      } catch(e) {}
    };
    this.scoreSource.onerror = () => {
      logger.warn('streamManager', 'Scores SSE error — reconnecting in 5s');
      this.scoreSource.close();
      setTimeout(() => { if (this.running) this._connectScores(); }, 5000);
    };
    this.scoreSource.addEventListener('heartbeat', () => {
      logger.debug('streamManager', 'Score heartbeat');
    });
  }

  _connectOdds() {
    if (!this.running) return;
    const url = process.env.TXLINE_API_ORIGIN + '/api/odds/stream';
    logger.info('streamManager', 'Connecting odds SSE');
    this.oddsSource = new EventSource(url, this._sseOptions());
    this.oddsSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data.FixtureId || !this.fixtureIds.has(data.FixtureId)) return;
        if (!data.InRunning || !data.Prices || !data.Prices.length) return;
        const key = data.FixtureId + ':' + data.MessageId;
        if (this.seenOdds.has(key)) return;
        this.seenOdds.add(key);
        this.onOdds(data);
      } catch(e) {}
    };
    this.oddsSource.onerror = () => {
      logger.warn('streamManager', 'Odds SSE error — reconnecting in 5s');
      this.oddsSource.close();
      setTimeout(() => { if (this.running) this._connectOdds(); }, 5000);
    };
    this.oddsSource.addEventListener('heartbeat', () => {
      logger.debug('streamManager', 'Odds heartbeat');
    });
  }

  _startPolling() {
    logger.info('streamManager', 'Starting backup polling every 30s');
    this.pollTimer = setInterval(() => this._poll(), 30000);
    this._poll();
  }

  async _poll() {
    if (!this.running) return;
    const slots = getCurrentSlots();
    const scoreUrls = slots.map(s => '/api/scores/updates/' + s.d + '/' + s.h + '/' + s.i);
    const oddsUrls = slots.map(s => '/api/odds/updates/' + s.d + '/' + s.h + '/' + s.i);

    const [scoreChunks, oddsChunks] = await Promise.all([
      Promise.all(scoreUrls.map(u => safeFetch(u))),
      Promise.all(oddsUrls.map(u => safeFetch(u)))
    ]);

    scoreChunks.flat()
      .filter(s => this.fixtureIds.has(s.FixtureId))
      .forEach(s => {
        const key = s.FixtureId + ':' + s.Seq + ':' + s.Ts;
        if (this.seenScores.has(key)) return;
        this.seenScores.add(key);
        logger.info('streamManager', 'POLL score event', { fixtureId: s.FixtureId, action: s.Action });
        this.onScore(s);
      });

    oddsChunks.flat()
      .filter(o => this.fixtureIds.has(o.FixtureId) && o.InRunning && o.Prices && o.Prices.length)
      .forEach(o => {
        const key = o.FixtureId + ':' + o.MessageId;
        if (this.seenOdds.has(key)) return;
        this.seenOdds.add(key);
        this.onOdds(o);
      });
  }

  stop() {
    this.running = false;
    if (this.scoreSource) this.scoreSource.close();
    if (this.oddsSource) this.oddsSource.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    logger.info('streamManager', 'Stopped');
  }

  getFixtures() { return this.fixtures; }
}

module.exports = { StreamManager };
