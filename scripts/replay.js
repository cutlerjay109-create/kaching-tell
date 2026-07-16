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
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀  kaching-tell — Goal Detection Pipeline');
  console.log('   Match: ' + fixture.Participant1 + ' vs ' + fixture.Participant2);
  console.log('   Fixture ID: ' + fixture.FixtureId);
  console.log('   Data source: TxLINE World Cup feed');
  console.log('   Solana: Mainnet');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

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

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚽  GOAL DETECTED');
    console.log('   Match:       ' + d.matchName);
    console.log('   Team:        ' + d.scoringTeam);
    console.log('   Clock:       ' + d.matchClockFormatted);
    console.log('   Score:       ' + d.scoreAtDetection);
    console.log('   Confidence:  ' + d.confidence);
    console.log('   Spike:       ' + d.spikeMagnitude + ' (' + d.spikeRatio + 'x baseline)');
    console.log('   Market:      ' + d.marketType);
    console.log('   Detected at: ' + new Date(d.wallTs).toISOString());
    console.log('   Source:      TxLINE fixture ' + d.fixtureId);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    store.addDetection(d);
    verifier.watch(d);

    console.log('🔗  Anchoring detection to Solana mainnet...');
    const sig = await anchorDetection(d, hashDetection(d));
    if (sig) {
      store.updateDetection(d.wallTs, d.fixtureId, { txSig: sig });
      console.log('✅  Anchored on Solana mainnet');
      console.log('   Transaction: ' + sig);
      console.log('   Verify at:   https://solscan.io/tx/' + sig);
    } else {
      console.log('⚠️  Anchor failed — detection recorded without on-chain proof');
    }
    console.log('');
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
      console.log('✅  VERIFIED — Official stat confirmed goal');
      console.log('   Scorer:    ' + r.confirmedScoringTeam);
      console.log('   Score:     ' + r.confirmedScore);
      console.log('   Lead time: ' + Math.round((r.leadTimeMs||0)/1000) + ' seconds before official confirmation');
      console.log('');
    } else {
      console.log('❌  FALSE POSITIVE — Stat did not increment within 5 minutes');
      console.log('   Reason: ' + (r.fpReason || 'VAR review or disallowed goal'));
      console.log('');
    }
  });

  // Pass 1: feed all events through detector
  const allEvents = [
    ...scores.map(s => ({ ...s, _type: 'score' })),
    ...odds.map(o => ({ ...o, _type: 'odds' }))
  ].sort((a,b) => a.Ts - b.Ts);

  console.log('');
  console.log('📡  Replaying ' + allEvents.length + ' real TxLINE events from ' + fixture.Participant1 + ' vs ' + fixture.Participant2 + '...');
  console.log('   Score events: ' + scores.length);
  console.log('   Odds events:  ' + odds.length);
  console.log('');
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
  console.log('⏳  Waiting for official stat confirmation...');
  for (const event of allEvents) {
    if (event._type === 'score') {
      verifier.onScoreEvent(event);
    }
  }

  // Wait for Solana transactions and verifications
  await new Promise(r => setTimeout(r, 15000));

  const stats = store.getStats();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊  CALIBRATION LEDGER SUMMARY');
  console.log('   Total detections: ' + stats.total);
  console.log('   Verified:         ' + stats.verified);
  console.log('   False positives:  ' + stats.fp);
  console.log('   Accuracy:         ' + stats.accuracy + '%');
  console.log('   Avg lead time:    ' + stats.avgLead + 's before official confirmation');
  console.log('   Dashboard:        https://kaching-tell-production.up.railway.app');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

async function main() {
  // Fetch all World Cup fixtures
  logger.info('replay', 'Fetching World Cup fixtures...');
  const res = await client.get('/api/fixtures/snapshot');
  const all = res.data || [];
  const wc = all.filter(f => f.CompetitionId === COMPETITION_ID);

  console.log('');
  console.log('🏆  Available World Cup fixtures:');
  wc.forEach((f, i) => {
    console.log('   [' + i + '] ' + f.Participant1 + ' vs ' + f.Participant2 + ' | Start: ' + new Date(f.StartTime).toISOString() + ' | Id: ' + f.FixtureId);
  });
  console.log('');

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
    console.log('ℹ️   No fixture specified — using: ' + fixture.Participant1 + ' vs ' + fixture.Participant2);
    console.log('   Tip: run with a specific fixture ID: node scripts/replay.js <fixtureId>');
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
