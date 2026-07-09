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
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(data, null, 2));
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
