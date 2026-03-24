import DLMM from '@meteora-ag/dlmm';
import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, getWallet } from './wallet.js';
import { isDryRun } from '../config.js';

function toBN(amount, decimals) {
  return new BN((amount * 10 ** decimals).toFixed(0));
}

export async function openPosition(poolAddress, xAmount, yAmount) {
  if (isDryRun()) return { dryRun: true };

  const conn = getConnection();
  const wallet = getWallet();

  const pool = await DLMM.create(conn, new PublicKey(poolAddress));
  const activeBin = await pool.getActiveBin();

  const x = toBN(xAmount, pool.tokenX.decimal || 9);
  const y = toBN(yAmount, pool.tokenY.decimal || 6);

  const pos = Keypair.generate();

  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: pos.publicKey,
    user: wallet.publicKey,
    totalXAmount: x,
    totalYAmount: y,
    strategy: {
      minBinId: activeBin.binId - 2,
      maxBinId: activeBin.binId + 2,
      strategyType: 0,
    },
  });

  const latest = await conn.getLatestBlockhash();

  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet, pos);

  const sig = await conn.sendRawTransaction(tx.serialize());

  await conn.confirmTransaction({
    signature: sig,
    ...latest,
  });

  return { success: true, tx: sig };
}
