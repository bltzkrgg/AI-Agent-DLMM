import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbBackup } from '../src/db/backup.js';

test('DbBackup.listBackups includes backup size metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'dlmm-backup-test-'));
  const backupDir = join(root, 'backups');
  const dbPath = join(root, 'data.db');

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(dbPath, 'sqlite-placeholder');
  writeFileSync(join(backupDir, 'data.db.2026-04-08T00-00-00.000Z'), 'abc123');

  const backup = new DbBackup(dbPath, backupDir);
  const list = backup.listBackups();

  assert.equal(list.length, 1);
  assert.equal(list[0].name.startsWith('data.db.'), true);
  assert.equal(list[0].size, 6);
});
