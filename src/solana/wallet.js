import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getHeliusRpcUrl, getRpcManager } from '../utils/helius.js';

let wallet;

export function initSolana() {
  const manager = getRpcManager();
  if (manager) {
    console.log(`✅ RPC: Managed (Initial primary: ${manager.getPrimaryProvider().name})`);
  } else {
    try {
      getHeliusRpcUrl();
      console.log('✅ RPC: Helius');
    } catch {
      if (!process.env.SOLANA_RPC_URL) throw new Error('Neither HELIUS_API_KEY nor SOLANA_RPC_URL is set');
      console.log('⚠️  RPC: fallback ke SOLANA_RPC_URL (Helius direkomendasikan)');
    }
  }

  const privateKeyBytes = bs58.decode(process.env.WALLET_PRIVATE_KEY);
  wallet = Keypair.fromSecretKey(privateKeyBytes);

  console.log(`✅ Wallet loaded: ${wallet.publicKey.toString()}`);
  return { wallet };
}

export function getConnection() {
  const manager = getRpcManager();
  if (manager) {
    return manager.getConnection('confirmed');
  }

  // Pure fallback: Create a one-off connection if no manager exists
  const rpcUrl = process.env.SOLANA_RPC_URL || getHeliusRpcUrl();
  return new Connection(rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 90000,
  });
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
