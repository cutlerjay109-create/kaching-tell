require('dotenv').config();
const axios = require('axios');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 15000
});

function getCurrentSlot() {
  const now = new Date();
  return {
    epochDay: Math.floor(Date.now() / 86400000),
    hourOfDay: now.getUTCHours(),
    interval: Math.floor(now.getUTCMinutes() / 10)
  };
}

async function fetchScoreSlot(epochDay, hourOfDay, interval) {
  try {
    const url = '/api/scores/updates/' + epochDay + '/' + hourOfDay + '/' + interval;
    const res = await client.get(url);
    return res.data || [];
  } catch(e) {
    return [];
  }
}

module.exports = { fetchScoreSlot, getCurrentSlot };
