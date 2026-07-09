require('dotenv').config();
const axios = require('axios');
const { GoalDetector } = require('../src/detection/goalDetector');
const { Verifier } = require('../src/detection/verifier');
const { Store } = require('../src/ledger/store');
const { writeLedger } = require('../src/ledger/writer');
const { anchorDetection } = require('../src/anchor/anchor');
const { hashDetection } = require('../src/utils/hash');
const logger = require('../src/utils/logger');

const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 60000
});

const FIXTURE = {
  FixtureId: 17926687,
  Participant1: 'France',
  Participant2: 'Morocco',
  StartTime: 1781974800000
};
const DAY = 20624;
const HOURS = [17, 18, 19, 20];

async function safeFetch(url) {
  try { return (await client.get(url)).data || []; } catch(e) { return []; }
}

async function main() {
  logger.info('replay', 'Fetching historical data...');

  const scoreUrls = [];
  const oddsUrls = [];
  for (const h of HOURS)
    for (const i of [0,1,2,3,4,5]) {
      scoreUrls.push('/api/scores/updates/' + DAY + '/' + h + '/' + i);
      oddsUrls.push('/api/odds/updates/' + DAY + '/' + h + '/' + i);
    }

  const [scoreChunks, oddsChunks] = await Promise.all([
    Promise.all(scoreUrls.map(u => safeFetch(u))),
    Promise.all(oddsUrls.map(u => safeFetch(u)))
  ]);

  const scores = scoreChunks.flat()
    .filter(s => s.FixtureId === FIXTURE.FixtureId && s.Action)
    .sort((a,b) => a.Ts - b.Ts);

  const odds = oddsChunks.flat()
    .filter(o => o.FixtureId === FIXTURE.FixtureId && o.InRunning && o.Prices && o.Prices.length)
    .sort((a,b) => a.Ts - b.Ts);

  logger.info('replay', 'Scores: ' + scores.length + ' | Odds: ' + odds.length);

  const store = new Store();
  const verifier = new Verifier();
  const detector = new GoalDetector(FIXTURE);

  let detectionCount = 0;

  detector.on('detection', async (detection) => {
    detectionCount++;
    logger.info('replay', 'DETECTION #' + detectionCount, {
      scoringTeam: detection.scoringTeam,
      clock: detection.matchClockFormatted,
      score: detection.scoreAtDetection,
      spike: detection.spikeMagnitude,
      conf: detection.confidence,
      market: detection.marketType
    });

    store.addDetection(detection);
    const hash = hashDetection(detection);
    const sig = await anchorDetection(detection, hash);
    store.updateDetection(detection.wallTs, detection.fixtureId, { txSig: sig, hash });
    verifier.watch(detection);
    writeLedger(store);
  });

  verifier.on('result', (result) => {
    logger.info('replay', 'RESULT: ' + result.status, {
      confirmedScoringTeam: result.confirmedScoringTeam,
      confirmedScore: result.confirmedScore,
      leadTimeMs: result.leadTimeMs
    });
    store.updateDetection(result.wallTs, result.fixtureId, {
      status: result.status,
      leadTimeMs: result.leadTimeMs,
      confirmedScoringTeam: result.confirmedScoringTeam,
      confirmedScore: result.confirmedScore,
      scoreAtDetection: result.confirmedScore,
      fpReason: result.fpReason
    });
    writeLedger(store);
  });

  const allEvents = [
    ...scores.map(s => ({ ...s, _type: 'score' })),
    ...odds.map(o => ({ ...o, _type: 'odds' }))
  ].sort((a,b) => a.Ts - b.Ts);

  logger.info('replay', 'Replaying ' + allEvents.length + ' events...');

  for (const event of allEvents) {
    if (event._type === 'score') {
      detector.onScoreEvent(event);
      verifier.onScoreEvent(event);
    } else {
      detector.onOddsEvent(event);
    }
  }

  // Wait for Solana transactions and verifications
  await new Promise(r => setTimeout(r, 15000));

  const stats = store.getStats();
  logger.info('replay', 'Complete', {
    detections: detectionCount,
    verified: stats.verified,
    fp: stats.fp,
    accuracy: stats.accuracy,
    avgLead: stats.avgLead + 's'
  });

  process.exit(0);
}

main().catch(console.error);
