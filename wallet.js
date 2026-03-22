import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

let connection;
let wallet;

export function initSolana() {
  connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

  const privateKeyBytes = bs58.decode(process.env.WALLET_PRIVATE_KEY);
  wallet = Keypair.fromSecretKey(privateKeyBytes);

  console.log(`✅ Wallet loaded: ${wallet.publicKey.toString()}`);
  return { connection, wallet };
}

export function getConnection() {
  return connection;
}

export function getWallet() {
  return wallet;
}

export async function getWalletBalance() {
  const balance = await connection.getBalance(wallet.publicKey);
  return (balance / 1e9).toFixed(4); // Convert lamports to SOL
}

export async function getTokenBalance(mintAddress) {
  try {
    const mint = new PublicKey(mintAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint }
    );

    if (tokenAccounts.value.length === 0) return 0;

    const amount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    return parseFloat(amount.uiAmount || 0);
  } catch (e) {
    return 0;
  }
}
