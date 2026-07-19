const fs = require('fs');
const path = require('path');
const { LEDGER_FILE } = require('../config/constants');
const logger = require('../utils/logger');

function ensureDir() {
  const dir = path.dirname(LEDGER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeLedger(store) {
  try {
    ensureDir();
    const data = {
      updatedAt: new Date().toISOString(),
      stats: store.getStats(),
      detections: store.getAll()
    };
    // Atomic write: write to a temp file then rename, so a crash mid-write can
    // never leave a truncated/corrupted ledger.json (which would fail to parse
    // on restart and lose the on-chain proof history).
    const tmp = LEDGER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, LEDGER_FILE);
  } catch (err) {
    logger.error('writer', 'Failed to write ledger', { err: err.message });
  }
}

function readLedger() {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return null;
    return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (err) { return null; }
}

module.exports = { writeLedger, readLedger };
