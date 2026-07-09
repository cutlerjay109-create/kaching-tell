require('dotenv').config();
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const logger = require('../utils/logger');

// bs58 v6+ uses default export
const encode = bs58.default ? bs58.default.encode.bind(bs58.default) : bs58.encode.bind(bs58);
const decode = bs58.default ? bs58.default.decode.bind(bs58.default) : bs58.decode.bind(bs58);

let _keypair = null;

function getKeypair() {
  if (_keypair) return _keypair;
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) {
    _keypair = Keypair.generate();
    logger.warn('wallet', 'No AGENT_PRIVATE_KEY — generated new keypair');
    logger.warn('wallet', 'Add to .env: AGENT_PRIVATE_KEY=' + encode(_keypair.secretKey));
  } else {
    _keypair = Keypair.fromSecretKey(decode(key));
  }
  logger.info('wallet', 'Agent wallet: ' + _keypair.publicKey.toBase58());
  return _keypair;
}

module.exports = { getKeypair };
