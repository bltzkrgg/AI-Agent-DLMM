#!/usr/bin/env node

/**
 * Manual DB restore tool
 * Usage: node scripts/restore-db.js --from <backup-file>
 * Example: node scripts/restore-db.js --from "2026-04-07T12-30-45.123Z"
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { DbBackup } from '../src/db/backup.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function main() {
  const args = process.argv.slice(2);
  const fromArg = args.indexOf('--from');
  const fromValue = fromArg !== -1 ? args[fromArg + 1] : null;

  const dbPath = process.env.BOT_DB_PATH || path.join(process.cwd(), 'data.db');
  const backup = new DbBackup(dbPath);

  console.log('\n📦 Database Restore Tool\n');
  console.log(`DB Path: ${dbPath}\n`);

  // List available backups
  const backups = backup.listBackups();
  if (backups.length === 0) {
    console.error('❌ No backups available.');
    process.exit(1);
  }

  console.log('Available backups:\n');
  backups.forEach((b, i) => {
    const date = new Date(b.mtime).toLocaleString();
    const size = (b.mtime / 1024).toFixed(2);
    console.log(`  [${i}] ${b.name} (${date})`);
  });
  console.log('');

  let selectedBackup;

  if (fromValue) {
    // Command line argument provided
    selectedBackup = backups.find(b => b.name.includes(fromValue));
    if (!selectedBackup) {
      console.error(`❌ Backup containing "${fromValue}" not found`);
      process.exit(1);
    }
  } else {
    // Interactive selection
    const choice = await question('Enter backup number to restore (or press Ctrl+C to cancel): ');
    const index = parseInt(choice, 10);

    if (isNaN(index) || index < 0 || index >= backups.length) {
      console.error('❌ Invalid selection');
      process.exit(1);
    }

    selectedBackup = backups[index];
  }

  console.log(`\nSelected: ${selectedBackup.name}`);
  console.log(`Date: ${new Date(selectedBackup.mtime).toLocaleString()}`);

  // Confirm before restore
  const confirm = await question(
    '\n⚠️  This will overwrite the current database. Continue? (yes/no): '
  );

  if (confirm.toLowerCase() !== 'yes') {
    console.log('❌ Restore cancelled');
    process.exit(0);
  }

  try {
    backup.restore(selectedBackup.path);
    console.log('\n✅ Restore completed successfully.');
    console.log('⚠️  Please restart the bot to use the restored database.');
  } catch (e) {
    console.error('\n❌ Restore failed:', e.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
