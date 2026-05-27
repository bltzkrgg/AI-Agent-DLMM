import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readmePath = resolve(process.cwd(), 'README.md');

test('README explains fast-path, slow-path, and monitor trade offs', () => {
  const source = readFileSync(readmePath, 'utf8');

  assert.match(source, /Exit monitoring now uses a hybrid model:/);
  assert.match(source, /Fast-path: jalur cepat buat cek harga dan profit loss secara ringan/);
  assert.match(source, /Slow-path: jalur lebih berat buat hitung nilai posisi, TA, dan detail logging/);
  assert.match(source, /Trade off kuota vs presisi: makin cepat responnya, makin sering bot bangun dan makin boros kuota/);
  assert.match(source, /monitorFastLaneFallbackPollMs/);
  assert.match(source, /outOfRangeWaitMinutes.*actual wait before the position is closed/);
  assert.match(source, /oorDisplayWaitMinutes.*only controls how often the OOR status is shown/);
  assert.match(source, /Wallet Net Delta.*real post-close SOL movement/);
  assert.match(source, /Close flow stays zap-first/);
  assert.match(source, /Entry anchor freeze: candidate yang sudah masuk WATCH akan membawa `entryActiveBin`\/`entryPrice` snapshot ke queue dan deploy/);
  assert.match(source, /Live bin fallback: deploy hanya pakai bin live jika snapshot intent tidak valid/);
  assert.match(source, /If the range would require a new bin array, deploy is vetoed before position init/);
});
