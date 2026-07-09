require('dotenv').config();
const { getKeypair } = require('../src/anchor/wallet');
const keypair = getKeypair();
console.log('\nAgent wallet address:');
console.log(keypair.publicKey.toBase58());
console.log('\nSend at least 0.05 SOL to this address before running the agent.\n');
