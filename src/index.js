require('dotenv').config();
const { StreamManager } = require('./feeds/streamManager');
const { GoalDetector } = require('./detection/goalDetector');
const { Verifier } = require('./detection/verifier');
const { anchorDetection } = require('./anchor/anchor');
const { Store } = require('./ledger/store');
const { writeLedger, readLedger } = require('./ledger/writer');
const { hashDetection } = require('./utils/hash');
const { startDashboard } = require('./dashboard/server');
const logger = require('./utils/logger');
const axios = require('axios');

const store = new Store();
const verifier = new Verifier();
const detectors = new Map();

const client = axios.create({
  baseURL: process.env.TXLINE_API_ORIGIN,
  headers: {
    'Authorization': 'Bearer ' + process.env.TXLINE_JWT,
    'X-Api-Token': process.env.TXLINE_API_TOKEN,
  },
  timeout: 15000
});

async function fetchCurrentScore(fixtureId) {
  // TxLINE batch endpoint has corrupted stats in second half
  // Score is tracked live from SSE events instead
  // Start from 0 and let live events update naturally
  logger.info('main', 'Score will be tracked from live SSE events', { fixtureId });
  return { homeGoals: 0, awayGoals: 0, totalGoals: 0 };
}

async function main() {
  logger.info('main', 'kaching-tell starting');

  const existing = readLedger();
  if (existing && existing.detections && existing.detections.length > 0) {
    existing.detections.forEach(d => store.addDetection(d));
    logger.info('main', 'Loaded existing ledger', { detections: existing.detections.length });
  }

  startDashboard(store);

  const manager = new StreamManager(
    (scoreEvent) => handleScore(scoreEvent),
    (oddsEvent) => handleOdds(oddsEvent)
  );

  const fixtures = await manager.start();

  if (!fixtures.length) {
    logger.warn('main', 'No fixtures to monitor. Dashboard is running.');
    return;
  }

  // For each fixture fetch current score to seed state
  for (const fixture of fixtures) {
    const currentScore = await fetchCurrentScore(fixture.FixtureId);

    const detector = new GoalDetector(fixture);

    // Seed the detector with current score so it knows real state
    detector.homeGoals = currentScore.homeGoals;
    detector.awayGoals = currentScore.awayGoals;

    detectors.set(fixture.FixtureId, detector);
    store.setMatchInfo(fixture.FixtureId, fixture);

    logger.info('main', 'Detector seeded', {
      fixture: fixture.Participant1 + ' vs ' + fixture.Participant2,
      homeGoals: currentScore.homeGoals,
      awayGoals: currentScore.awayGoals
    });

    // Seed verifier with current goal count as baseline
    verifier.seedBaseline(fixture.FixtureId, currentScore.totalGoals, currentScore.homeGoals, currentScore.awayGoals);

    detector.on('detection', async (detection) => {
      store.addDetection(detection);
      verifier.watch(detection);
      const hash = hashDetection(detection);
      const sig = await anchorDetection(detection, hash);
      store.updateDetection(detection.wallTs, detection.fixtureId, { txSig: sig, hash });
      writeLedger(store);
    });

    detector.on('matchFinished', (fixtureId) => {
      logger.info('main', 'Match finished', { fixtureId });
      detectors.delete(fixtureId);
      writeLedger(store);
    });
  }

  verifier.on('result', (result) => {
    store.updateDetection(result.wallTs, result.fixtureId, {
      status: result.status,
      leadTimeMs: result.leadTimeMs,
      confirmedScoringTeam: result.confirmedScoringTeam,
      confirmedScore: result.confirmedScore,
      // Correct the displayed score to the confirmed post-goal score.
      // Without this the dashboard stays stuck on the pre-goal score forever.
      scoreAtDetection: result.confirmedScore || undefined,
      scoringTeam: result.confirmedScoringTeam || undefined,
      fpReason: result.fpReason || undefined
    });
    logger.info('main', 'Verification: ' + result.status, {
      fixtureId: result.fixtureId,
      leadTimeMs: result.leadTimeMs
    });
    writeLedger(store);
  });

  setInterval(() => {
    if (store.getAll().length > 0) writeLedger(store);
  }, 30000);

  logger.info('main', 'Monitoring ' + fixtures.length + ' fixtures');
}

function handleScore(event) {
  const detector = detectors.get(event.FixtureId);
  if (detector) detector.onScoreEvent(event);
  verifier.onScoreEvent(event);
}

function handleOdds(event) {
  const detector = detectors.get(event.FixtureId);
  if (detector) detector.onOddsEvent(event);
}

main().catch(err => {
  logger.error('main', 'Fatal', { err: err.message });
  process.exit(1);
});
