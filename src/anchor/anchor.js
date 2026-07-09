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
  try {
    const keypair = getKeypair();
    const conn = getConnection();
    const memo = buildMemo(detection, hash);
    const ix = new TransactionInstruction({
      keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM,
      data: Buffer.from(memo, 'utf8')
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [keypair]);
    logger.info('anchor', 'Anchored', { sig, fixtureId: detection.fixtureId });
    return sig;
  } catch (err) {
    logger.error('anchor', 'Anchor failed', { err: err.message });
    return null;
  }
}

module.exports = { anchorDetection };
