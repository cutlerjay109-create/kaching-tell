require('dotenv').config();
const axios = require('axios');
const { GoalDetector } = require('../src/detection/goalDetector');
const { Verifier } = require('../src/detection/verifier');
const { Store } = require('../src/ledger/store');
const { writeLedger } = require('../src/ledger/writer');
const { anchorDetection } = require('../src/anchor/anchor');
const { hashDetection } = require('../src/utils/hash');
const { COMPETITION_ID } = require('../src/config/constants');
const logger = require('../src/utils/logger');

const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 60000
});

// Optional: pass fixture ID as argument e.g. node scripts/replay.js 17926687
const TARGET_FIXTURE_ID = process.argv[2] ? parseInt(process.argv[2]) : null;

async function safeFetch(url) {
  try { return (await client.get(url)).data || []; } catch(e) { return []; }
}

function getEpochDay(date) {
  return Math.floor(date.getTime() / 86400000);
}

function getHoursForMatch(startTimeMs) {
  const start = new Date(startTimeMs);
  const startHour = start.getUTCHours();
  // Cover 3 hours from kickoff to handle full match + extra time
  return [startHour, startHour + 1, startHour + 2, startHour + 3].filter(h => h >= 0 && h <= 23);
}

async function fetchMatchData(fixture) {
  const startDate = new Date(fixture.StartTime);
  const epochDay = getEpochDay(startDate);
  const hours = getHoursForMatch(fixture.StartTime);

  logger.info('replay', 'Fetching data for ' + fixture.Participant1 + ' vs ' + fixture.Participant2, { epochDay, hours });

  const scoreUrls = [];
  const oddsUrls = [];
  for (const h of hours) {
    for (const i of [0,1,2,3,4,5]) {
      scoreUrls.push('/api/scores/updates/' + epochDay + '/' + h + '/' + i);
      oddsUrls.push('/api/odds/updates/' + epochDay + '/' + h + '/' + i);
    }
  }

  const [scoreChunks, oddsChunks] = await Promise.all([
    Promise.all(scoreUrls.map(u => safeFetch(u))),
    Promise.all(oddsUrls.map(u => safeFetch(u)))
  ]);

  const scores = scoreChunks.flat()
    .filter(s => s.FixtureId === fixture.FixtureId && s.Action)
    .sort((a,b) => a.Ts - b.Ts);

  const odds = oddsChunks.flat()
    .filter(o => o.FixtureId === fixture.FixtureId && o.InRunning && o.Prices && o.Prices.length)
    .sort((a,b) => a.Ts - b.Ts);

  return { scores, odds };
}

async function replayFixture(fixture) {
  logger.info('replay', '=== REPLAYING: ' + fixture.Participant1 + ' vs ' + fixture.Participant2 + ' ===');

  const { scores, odds } = await fetchMatchData(fixture);
  logger.info('replay', 'Score events: ' + scores.length + ' | Odds events: ' + odds.length);

  if (!scores.length || !odds.length) {
    logger.warn('replay', 'Insufficient data for this fixture. Try a different one.');
    return;
  }

  const store = new Store();
  const verifier = new Verifier();
  const detector = new GoalDetector(fixture);
  let detectionCount = 0;

  detector.on('detection', async (d) => {
    detectionCount++;
    logger.info('replay', 'DETECTION #' + detectionCount + ' | ' + d.scoringTeam + ' scored at ' + d.matchClockFormatted + ' | Score: ' + d.scoreAtDetection + ' | Confidence: ' + d.confidence);
    store.addDetection(d);
    verifier.watch(d);
    const sig = await anchorDetection(d, hashDetection(d));
    if (sig) {
      store.updateDetection(d.wallTs, d.fixtureId, { txSig: sig });
      logger.info('replay', 'ANCHORED ON SOLANA: ' + sig.substring(0,20) + '...');
    }
    writeLedger(store);
  });

  verifier.on('result', (r) => {
    store.updateDetection(r.wallTs, r.fixtureId, {
      status: r.status,
      leadTimeMs: r.leadTimeMs,
      confirmedScoringTeam: r.confirmedScoringTeam,
      scoreAtDetection: r.confirmedScore || r.scoreAtDetection
    });
    writeLedger(store);
    if (r.status === 'verified') {
      logger.info('replay', 'VERIFIED: ' + r.confirmedScoringTeam + ' | Score: ' + r.confirmedScore + ' | Lead: ' + Math.round((r.leadTimeMs||0)/1000) + 's');
    } else {
      logger.warn('replay', 'FALSE POSITIVE: ' + (r.fpReason || 'stat did not increment'));
    }
  });

  // Pass 1: feed all events through detector
  const allEvents = [
    ...scores.map(s => ({ ...s, _type: 'score' })),
    ...odds.map(o => ({ ...o, _type: 'odds' }))
  ].sort((a,b) => a.Ts - b.Ts);

  logger.info('replay', 'Pass 1: replaying ' + allEvents.length + ' events...');
  for (const event of allEvents) {
    if (event._type === 'score') {
      detector.onScoreEvent(event);
    } else {
      detector.onOddsEvent(event);
    }
  }

  // Wait for all detections to fire
  await new Promise(r => setTimeout(r, 8000));

  // Pass 2: feed score events again so verifier can confirm
  logger.info('replay', 'Pass 2: verifier confirmation pass...');
  for (const event of allEvents) {
    if (event._type === 'score') {
      verifier.onScoreEvent(event);
    }
  }

  // Wait for Solana transactions and verifications
  await new Promise(r => setTimeout(r, 15000));

  const stats = store.getStats();
  logger.info('replay', '=== REPLAY COMPLETE ===');
  logger.info('replay', 'Detections: ' + stats.total + ' | Verified: ' + stats.verified + ' | FP: ' + stats.fp + ' | Accuracy: ' + stats.accuracy + '% | Avg Lead: ' + stats.avgLead + 's');
}

async function main() {
  // Fetch all World Cup fixtures
  logger.info('replay', 'Fetching World Cup fixtures...');
  const res = await client.get('/api/fixtures/snapshot');
  const all = res.data || [];
  const wc = all.filter(f => f.CompetitionId === COMPETITION_ID);

  logger.info('replay', 'Available World Cup fixtures:');
  wc.forEach((f, i) => {
    logger.info('replay', '  [' + i + '] FixtureId: ' + f.FixtureId + ' | ' + f.Participant1 + ' vs ' + f.Participant2 + ' | Start: ' + new Date(f.StartTime).toISOString());
  });

  let fixture;
  if (TARGET_FIXTURE_ID) {
    // Use specified fixture
    fixture = wc.find(f => f.FixtureId === TARGET_FIXTURE_ID);
    if (!fixture) {
      // Try with hardcoded known fixture
      fixture = { FixtureId: TARGET_FIXTURE_ID, Participant1: 'Home Side', Participant2: 'Away Side', StartTime: Date.now() - 7200000 };
      logger.warn('replay', 'Fixture not in current snapshot — using provided ID with generic names');
    }
  } else if (wc.length > 0) {
    // Use first available World Cup fixture
    fixture = wc[0];
    logger.info('replay', 'No fixture specified — using: ' + fixture.Participant1 + ' vs ' + fixture.Participant2);
    logger.info('replay', 'Tip: run with a specific fixture ID: node scripts/replay.js <fixtureId>');
  } else {
    logger.error('replay', 'No World Cup fixtures available. Check your TxLINE credentials.');
    process.exit(1);
  }

  await replayFixture(fixture);
  process.exit(0);
}

main().catch(err => {
  logger.error('replay', 'Fatal: ' + err.message);
  process.exit(1);
});
