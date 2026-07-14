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

const store = new Store();
const verifier = new Verifier();
const detectors = new Map();

async function main() {
  logger.info('main', 'kaching-tell starting');

  // Load existing ledger into store on startup
  const existing = readLedger();
  if (existing && existing.detections && existing.detections.length > 0) {
    existing.detections.forEach(d => store.addDetection(d));
    logger.info('main', 'Loaded existing ledger', { detections: existing.detections.length });
  }

  startDashboard(store);

  const manager = new StreamManager(
    (scoreEvent) => handleScore(scoreEvent),
    (oddsEvent)  => handleOdds(oddsEvent)
  );

  const fixtures = await manager.start();

  if (!fixtures.length) {
    logger.warn('main', 'No fixtures to monitor. Dashboard is running.');
    return;
  }

  fixtures.forEach(fixture => {
    const detector = new GoalDetector(fixture);
    detectors.set(fixture.FixtureId, detector);
    store.setMatchInfo(fixture.FixtureId, fixture);

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
  });

  verifier.on('result', (result) => {
    store.updateDetection(result.wallTs, result.fixtureId, {
      status: result.status,
      leadTimeMs: result.leadTimeMs,
      confirmedGoals: result.confirmedGoals
    });
    logger.info('main', 'Verification: ' + result.status, { fixtureId: result.fixtureId });
    writeLedger(store);
  });

  // Only write ledger periodically if there is data
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
