require('dotenv').config();
const {
  Connection, Transaction, TransactionInstruction, PublicKey
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Confirm a signature by POLLING getSignatureStatuses over HTTP. This avoids the
// WebSocket `signatureSubscribe` method that sendAndConfirmTransaction relies on,
// which some providers (e.g. Alchemy) do not support and which caused every
// anchor to look like it failed even though the transaction landed on-chain.
async function pollConfirm(conn, sig) {
  for (let i = 0; i < 20; i++) {
    try {
      const st = await conn.getSignatureStatuses([sig]);
      const s = st && st.value && st.value[0];
      if (s) {
        if (s.err) return false;
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return true;
      }
    } catch (_) { /* transient - keep polling */ }
    await sleep(1500);
  }
  return false; // timed out waiting; caller still returns the sig (tx likely landed)
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

  // Submit + confirm over HTTP only (no websocket). Retry a few times on transient
  // send failures (rate limits / blockhash expiry). Set SOLANA_RPC to a dedicated
  // provider for reliability.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: keypair.publicKey }).add(ix);
      tx.sign(keypair);

      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });

      const confirmed = await pollConfirm(conn, sig);
      if (confirmed) {
        logger.info('anchor', 'Anchored', { sig, fixtureId: detection.fixtureId, attempt });
      } else {
        // The transaction was submitted and almost always lands; return the sig so
        // the dashboard can link it rather than showing "anchoring..." forever.
        logger.warn('anchor', 'Submitted (confirmation slow) - returning sig', { sig, fixtureId: detection.fixtureId });
      }
      return sig;
    } catch (err) {
      logger.error('anchor', 'Anchor attempt failed', { attempt, err: err.message });
      if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
    }
  }
  logger.error('anchor', 'Anchor failed after retries', { fixtureId: detection.fixtureId });
  return null;
}

module.exports = { anchorDetection };
