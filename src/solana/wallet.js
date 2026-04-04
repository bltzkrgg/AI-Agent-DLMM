import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getHeliusRpcUrl } from '../utils/helius.js';

let connection;
let wallet;

export function initSolana() {
  // Helius RPC sebagai primary — lebih reliable, rate limit lebih tinggi.
  // Fallback ke SOLANA_RPC_URL jika HELIUS_API_KEY tidak ada.
  let rpcUrl;
  try {
    rpcUrl = getHeliusRpcUrl();
    console.log('✅ RPC: Helius');
  } catch {
    rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) throw new Error('Neither HELIUS_API_KEY nor SOLANA_RPC_URL is set');
    console.log('⚠️  RPC: fallback ke SOLANA_RPC_URL (Helius direkomendasikan)');
  }

  connection = new Connection(rpcUrl, {
    commitment:            'confirmed',
    confirmTransactionInitialTimeout: 90000,  // 90 detik timeout konfirmasi
    wsEndpoint: rpcUrl.startsWith('https://')
      ? rpcUrl.replace('https://', 'wss://')
      : undefined,
  });

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
  const { PublicKey } = await import('@solana/web3.js');
  try {
    const mint = new PublicKey(mintAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint }
    );

    if (tokenAccounts.value.length === 0) return 0;

    const amount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    return parseFloat(amount.uiAmount || 0);
  } catch {
    return 0;
  }
}
