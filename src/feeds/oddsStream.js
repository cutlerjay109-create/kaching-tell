require('dotenv').config();
const axios = require('axios');

const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 15000
});

async function fetchOddsSlot(epochDay, hourOfDay, interval) {
  try {
    const url = '/api/odds/updates/' + epochDay + '/' + hourOfDay + '/' + interval;
    const res = await client.get(url);
    return res.data || [];
  } catch(e) {
    return [];
  }
}

module.exports = { fetchOddsSlot };
