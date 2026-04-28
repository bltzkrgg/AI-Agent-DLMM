'use strict';

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export class DbBackup {
  constructor(dbPath, backupDir) {
    this.dbPath = dbPath;
    this.backupDir = backupDir;
  }

  listBackups() {
    if (!existsSync(this.backupDir)) return [];
    const prefix = `${basename(this.dbPath)}.`;
    return readdirSync(this.backupDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const fullPath = join(this.backupDir, name);
        const size = statSync(fullPath).size;
        return { name, path: fullPath, size };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }
}

