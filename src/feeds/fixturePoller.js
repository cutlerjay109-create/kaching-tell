require('dotenv').config();
const axios = require('axios');
const { COMPETITION_ID } = require('../config/constants');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 30000
});

async function fetchActiveFixtures() {
  return withRetry(async () => {
    const res = await client.get('/api/fixtures/snapshot');
    const all = res.data || [];
    const wc = all.filter(f => f.CompetitionId === COMPETITION_ID);
    logger.info('fixturePoller', 'Fetched fixtures', { total: all.length, worldCup: wc.length });
    return wc;
  }, 'fetchActiveFixtures');
}

module.exports = { fetchActiveFixtures };
