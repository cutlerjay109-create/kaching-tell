require('dotenv').config();
const { Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getKeypair } = require('../src/anchor/wallet');
const { SOLANA_RPC } = require('../src/config/constants');

async function main() {
  const keypair = getKeypair();
  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const balance = await conn.getBalance(keypair.publicKey);
  console.log('Wallet:  ' + keypair.publicKey.toBase58());
  console.log('Balance: ' + (balance / LAMPORTS_PER_SOL).toFixed(4) + ' SOL');
  console.log('Est txs: ~' + Math.floor(balance / 5000));
}

main().catch(console.error);
