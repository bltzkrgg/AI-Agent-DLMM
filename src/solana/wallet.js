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
  if (!wallet) return '0.0000';
  const connection = getConnection();
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    return (balance / 1e9).toFixed(4); // Convert lamports to SOL
  } catch (e) {
    console.warn(`⚠️ Gagal ambil saldo SOL: ${e.message}`);
    return '0.0000';
  }
}

/**
 * ⛽ GAS WATCHDOG (Aegis v1.0)
 * Memastikan saldo SOL cukup untuk biaya gas Sultan (P75 Priority).
 */
export async function checkGasReserve() {
  const balanceRaw = await getWalletBalance();
  const balance = parseFloat(balanceRaw);
  const threshold = 0.05; // 0.05 SOL minimum reserve

  if (balance < threshold) {
    const msg = `🚨 *LOW GAS WARNING!* Saldo SOL saat ini: \`${balance} SOL\`. Dibutuhkan minimal \`0.05 SOL\` untuk menjamin landing Sultan Gas. Silihkan top up atau kurangi posisi.`;
    const { saveNotification } = await import('../db/database.js');
    await saveNotification('gas_low_warning', msg);
    console.warn(`🚨 [wallet] CRYITICAL: Low gas reserve (${balance} SOL)`);
    return { low: true, balance };
  }
  return { low: false, balance };
}

export async function getTokenBalance(mintAddress) {
  const { PublicKey } = await import('@solana/web3.js');
  try {
    const connection = getConnection();
    const mint = new PublicKey(mintAddress);
    if (!wallet) return 0;
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

/**
 * 🧹 RENT RECOVERY (Clean-up Crew)
 * Menutup token account kosong dan menarik balik rent (0.002 SOL).
 */
export async function closeTokenAccount(mintAddress) {
  const { PublicKey, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
  const { getAssociatedTokenAddress, createCloseAccountInstruction, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
  
  try {
    const connection = getConnection();
    const mint = new PublicKey(mintAddress);
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);

    // Cek apakah akun ada dan saldonya 0 sebelum tutup
    const accountInfo = await connection.getParsedAccountInfo(ata);
    if (!accountInfo.value) return { success: true, note: 'Account already closed' };
    
    const balance = accountInfo.value.data.parsed.info.tokenAmount.uiAmount;
    if (balance > 0) {
      console.warn(`⚠️ [wallet] Gagal tutup akun ${mintAddress}: Masih ada saldo ${balance}`);
      return { success: false, error: 'Balance not zero' };
    }

    const transaction = new Transaction().add(
      createCloseAccountInstruction(
        ata,
        wallet.publicKey, // Destination for rent recovery
        wallet.publicKey, // Owner
        [],
        TOKEN_PROGRAM_ID
      )
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);
    console.log(`🧹 [wallet] Rent recovered! 0.002 SOL kembali ke dompet. (TX: ${signature.slice(0, 8)}...)`);
    
    // Track reclaimed rent in DB
    const { incrementStat } = await import('../db/database.js');
    await incrementStat('total_rent_reclaimed_sol', 0.00204);

    return { success: true, signature };
  } catch (err) {
    console.error(`❌ [wallet] Gagal Close Account ${mintAddress}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 🧹 MIDNIGHT SWEEPER (Global Rent Recovery)
 * Memindai seluruh wallet dan menutup SEMUA akun token kosong untuk menarik balik SOL.
 */
export async function runMidnightSweeper(notifyFn = null) {
  const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
  console.log('🧹 [wallet] Midnight Sweeper dimulai: Mencari akun token kosong...');
  
  try {
    const connection = getConnection();
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { programId: TOKEN_PROGRAM_ID }
    );

    const emptyAccounts = tokenAccounts.value.filter(a => {
      const amount = a.account.data.parsed.info.tokenAmount;
      return amount.uiAmount === 0;
    });

    if (emptyAccounts.length === 0) {
      console.log('✅ [wallet] Tidak ada akun kosong yang perlu disapu.');
      return;
    }

    console.log(`🧹 [wallet] Ditemukan ${emptyAccounts.length} akun kosong. Melakukan pembersihan massal...`);
    
    let recoveredCount = 0;
    for (const acc of emptyAccounts) {
      const mint = acc.account.data.parsed.info.mint;
      const res = await closeTokenAccount(mint);
      if (res.success) recoveredCount++;
      // Kasih nafas biar gak kaget RPC-nya
      await new Promise(r => setTimeout(r, 1000));
    }

    const totalSol = (recoveredCount * 0.00204).toFixed(4);
    const msg = `🧹 *MIDNIGHT SWEEPER COMPLETED*\n\n` +
               `🏠 Rumah bersih! Berhasil menutup \`${recoveredCount}\` akun kosong.\n` +
               `💰 Total Rent Balik: \`+${totalSol} SOL\``;
    
    console.log(`✅ [wallet] Sweeper selesai. Total recovered: ${totalSol} SOL`);
    if (notifyFn) await notifyFn(msg).catch(() => {});
  } catch (error) {
    console.error('❌ [wallet] Midnight Sweeper Error:', error.message);
  }
}
