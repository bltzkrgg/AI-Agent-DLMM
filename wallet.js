import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

let connection;
let wallet;

export function initSolana() {
  if (!process.env.SOLANA_RPC_URL) {
    throw new Error('SOLANA_RPC_URL missing');
  }

  if (!process.env.WALLET_PRIVATE_KEY) {
    throw new Error('WALLET_PRIVATE_KEY missing');
  }

  connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

  const secret = bs58.decode(process.env.WALLET_PRIVATE_KEY);
  wallet = Keypair.fromSecretKey(secret);

  console.log(`✅ Wallet loaded: ${wallet.publicKey.toString()}`);
}

export function getConnection() {
  return connection;
}

export function getWallet() {
  return wallet;
}

export async function getWalletBalance() {
  const bal = await connection.getBalance(wallet.publicKey);
  return bal / 1e9;
}
