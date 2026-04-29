import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const indexPath = resolve(process.cwd(), 'src/index.js');
const hunterPath = resolve(process.cwd(), 'src/agents/hunterAlpha.js');
const evilPandaPath = resolve(process.cwd(), 'src/sniper/evilPanda.js');

test('shutdown orchestration calls close + retry helpers', () => {
  const src = readFileSync(indexPath, 'utf8');
  assert.match(src, /closeAllActivePositionsForShutdown/);
  assert.match(src, /retryFailedShutdownPositions/);
  assert.match(src, /setShutdownInProgress\(true\)/);
});

test('hunter has shutdown guard and closing idempotency guard', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /let _shutdownInProgress = false/);
  assert.match(src, /const _closingPositions = new Set\(\)/);
  assert.match(src, /if \(_shutdownInProgress\)/);
  assert.match(src, /if \(_closingPositions\.has\(positionPubkey\)\)/);
});

test('evilPanda enforces on-chain close verification before success', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /async function verifyPositionClosedOnChain/);
  assert.match(src, /POSITION_STILL_OPEN_AFTER_EXIT_/);
  assert.match(src, /Position closed & verified/);
});

test('manual close helper records manual withdrawals when called explicitly', () => {
  const evilPandaSrc = readFileSync(evilPandaPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(evilPandaSrc, /export async function markPositionManuallyClosed/);
  assert.match(hunterSrc, /action === 'MANUAL_CLOSED'/);
  assert.match(hunterSrc, /Manual close terdeteksi/);
});

test('telegram exit command closes all active positions with verification summary', () => {
  const indexSrc = readFileSync(indexPath, 'utf8');
  const hunterSrc = readFileSync(hunterPath, 'utf8');
  assert.match(indexSrc, /closeAllActivePositionsByUser\('MANUAL_COMMAND'/);
  assert.match(indexSrc, /Manual exit selesai dan verified/);
  assert.match(indexSrc, /Manual exit belum bersih/);
  assert.match(hunterSrc, /export async function closeAllActivePositionsByUser/);
  assert.match(hunterSrc, /MANUAL_EXIT_NOT_VERIFIED/);
});

test('evilPanda uses macro positions with one Meteora account per chunk', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /const posKps = chunks\.map\(\(\) => Keypair\.generate\(\)\)/);
  assert.match(src, /const macroPositionId = posKps\.map\(kp => kp\.publicKey\.toString\(\)\)\.join\(','\)/);
  assert.match(src, /const posKp = posKps\[i\]/);
  assert.match(src, /initializePositionAndAddLiquidityByStrategy/);
  assert.match(src, /sendTransaction\(tx, \[wallet, posKp\]/);
  assert.match(src, /const activeChunks = userPositions\.filter\(p => chunkPubkeys\.includes\(p\.publicKey\.toString\(\)\)\)/);
});

test('macro monitor treats missing active chunks as stop loss fail-safe', () => {
  const src = readFileSync(evilPandaPath, 'utf8');
  assert.match(src, /if \(activeChunks\.length === 0\) \{/);
  assert.match(src, /action:\s*'STOP_LOSS'/);
  assert.match(src, /No active macro chunks found on-chain/);
});

test('deploy natural failures are silenced from Telegram notifications', () => {
  const src = readFileSync(hunterPath, 'utf8');
  assert.match(src, /function isNaturalDeployError/);
  assert.match(src, /'simulation failed'/);
  assert.match(src, /'slippage'/);
  assert.match(src, /'timeout'/);
  assert.match(src, /'blockhash'/);
  assert.match(src, /deployPosition natural fail silenced/);
});
