require('dotenv').config();
const {
  Connection, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction
} = require('@solana/web3.js');
const { SOLANA_RPC } = require('../config/constants');
const { getKeypair } = require('./wallet');
const { buildMemo } = require('./memo');
const logger = require('../utils/logger');

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
let connection = null;

function getConnection() {
  if (!connection) connection = new Connection(SOLANA_RPC, 'confirmed');
  return connection;
}

async function anchorDetection(detection, hash) {
  const keypair = getKeypair();
  const conn = getConnection();
  const memo = buildMemo(detection, hash);
  const ix = new TransactionInstruction({
    keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM,
    data: Buffer.from(memo, 'utf8')
  });

  // Public mainnet RPC is rate-limited; retry a few times before giving up so
  // detections don't get stuck showing "anchoring..." forever. Set SOLANA_RPC
  // to a dedicated endpoint (Helius/QuickNode/Triton) for reliable anchoring.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [keypair]);
      logger.info('anchor', 'Anchored', { sig, fixtureId: detection.fixtureId, attempt });
      return sig;
    } catch (err) {
      logger.error('anchor', 'Anchor attempt failed', { attempt, err: err.message });
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
  logger.error('anchor', 'Anchor failed after retries', { fixtureId: detection.fixtureId });
  return null;
}

module.exports = { anchorDetection };
