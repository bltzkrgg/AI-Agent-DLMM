import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { deriveBinArray } from '@meteora-ag/dlmm';

import {
  encodeDlmmBinArrayIndexSeed,
  deriveDlmmBinArrayPda,
} from '../src/solana/meteora.js';

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const SAMPLE_POOL = new PublicKey('7UXd3L81hNpoAsWo7vgBnoTFajHNHSiPBNbAQbwN2ET2');

test('negative bin-array index seed uses 64-bit two complement encoding', () => {
  assert.equal(encodeDlmmBinArrayIndexSeed(-13).toString('hex'), 'f3ffffffffffffff');
  assert.equal(encodeDlmmBinArrayIndexSeed(-1).toString('hex'), 'ffffffffffffffff');
  assert.equal(encodeDlmmBinArrayIndexSeed(13).toString('hex'), '0d00000000000000');
  assert.equal(encodeDlmmBinArrayIndexSeed(0).toString('hex'), '0000000000000000');
});

test('bin-array PDA derivation matches Meteora SDK for negative and positive indexes', () => {
  const indexes = [-13, -2, -1, 0, 1, 2, 13];
  for (const idx of indexes) {
    const ours = deriveDlmmBinArrayPda(SAMPLE_POOL, idx, DLMM_PROGRAM_ID).toBase58();
    const [sdkPda] = deriveBinArray(SAMPLE_POOL, new BN(String(idx)), DLMM_PROGRAM_ID);
    assert.equal(
      ours,
      sdkPda.toBase58(),
      `PDA mismatch for bin-array index ${idx}`,
    );
  }
});
