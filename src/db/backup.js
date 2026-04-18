import fs from 'fs';
import path from 'path';
const logger = console; // Fallback ke console jika logger tidak tersedia

export function resolveBackupDir(dbPath, explicitBackupDir = null) {
  if (explicitBackupDir) {
    return path.isAbsolute(explicitBackupDir)
      ? explicitBackupDir
      : path.resolve(explicitBackupDir);
  }
  if (process.env.BOT_BACKUP_DIR) {
    return path.isAbsolute(process.env.BOT_BACKUP_DIR)
      ? process.env.BOT_BACKUP_DIR
      : path.resolve(process.env.BOT_BACKUP_DIR);
  }
  // Default deterministic path: sibling folder dari DB file
  return path.join(path.dirname(dbPath), 'backups');
}

export class DbBackup {
  constructor(dbPath, backupDir = null) {
    this.dbPath = dbPath;
    this.backupDir = resolveBackupDir(dbPath, backupDir);
    this.retention = 7 * 24 * 60 * 60 * 1000; // 7 days

    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      logger.log(`📁 Created backup directory: ${this.backupDir}`);
    }
  }

  /**
   * Create timestamped backup of database
   * @returns {string} Path to backup file
   */
  async createBackup() {
    try {
      // Format: data.db.2026-04-07T12-30-45.123Z
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const backupPath = path.join(this.backupDir, `data.db.${timestamp}`);

      // Check if source DB exists
      if (!fs.existsSync(this.dbPath)) {
        logger.warn(`⚠️ DB file not found: ${this.dbPath}, skipping backup`);
        return null;
      }

      // Copy DB file
      fs.copyFileSync(this.dbPath, backupPath);
      logger.log(`✅ DB backup created: ${backupPath}`);

      // Cleanup old backups
      await this.cleanOldBackups();

      return backupPath;
    } catch (e) {
      logger.error('❌ Backup failed:', e.message);
      throw e;
    }
  }

  /**
   * Remove backups older than retention period
   */
  async cleanOldBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('data.db.'));

      let cleaned = 0;
      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        const stats = fs.statSync(filePath);
        const age = Date.now() - stats.mtime.getTime();

        if (age > this.retention) {
          fs.unlinkSync(filePath);
          logger.log(`🗑️  Cleaned old backup: ${file}`);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.log(`🗑️  Deleted ${cleaned} old backup(s)`);
      }
    } catch (e) {
      logger.warn('⚠️ Cleanup failed:', e.message);
      // Don't throw — cleanup failure shouldn't block the bot
    }
  }

  /**
   * List all available backups sorted by date (newest first)
   */
  listBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('data.db.'))
        .map(f => {
          const fullPath = path.join(this.backupDir, f);
          const stats = fs.statSync(fullPath);
          return {
            name: f,
            path: fullPath,
            mtime: stats.mtime,
            size: stats.size,
          };
        })
        .sort((a, b) => b.mtime - a.mtime);

      return files;
    } catch (e) {
      logger.warn('⚠️ Failed to list backups:', e.message);
      return [];
    }
  }

  /**
   * Restore database from backup
   * @param {string} backupPath - Path to backup file
   */
  restore(backupPath) {
    try {
      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
      }

      // Backup current DB before restoring (just in case)
      if (fs.existsSync(this.dbPath)) {
        const emergencyBackup = `${this.dbPath}.pre-restore.${Date.now()}`;
        fs.copyFileSync(this.dbPath, emergencyBackup);
        logger.log(`💾 Emergency backup created: ${emergencyBackup}`);
      }

      // Restore from backup
      fs.copyFileSync(backupPath, this.dbPath);
      logger.log(`✅ DB restored from: ${backupPath}`);

      return true;
    } catch (e) {
      logger.error('❌ Restore failed:', e.message);
      throw e;
    }
  }

  /**
   * Check if DB file is valid (basic integrity check)
   * Throws error if corrupted
   */
  validateDb() {
    try {
      if (!fs.existsSync(this.dbPath)) {
        throw new Error('DB file not found');
      }

      const stats = fs.statSync(this.dbPath);
      if (stats.size === 0) {
        throw new Error('DB file is empty');
      }

      // Try to open it and run PRAGMA integrity_check
      // This will be done by database.js during import
      return true;
    } catch (e) {
      logger.error('❌ DB validation failed:', e.message);
      throw e;
    }
  }

  /**
   * Attempt recovery from backup if DB is corrupted
   * @returns {boolean} true if recovery successful
   */
  async attemptRecovery() {
    logger.warn('⚠️ Database corrupted, attempting recovery...');

    const backups = this.listBackups();
    if (backups.length === 0) {
      logger.error('❌ No backups available for recovery');
      return false;
    }

    // Try backups from newest to oldest
    for (const backup of backups) {
      try {
        logger.log(`Trying backup: ${backup.name}`);
        this.restore(backup.path);

        // Validate restored DB
        this.validateDb();
        logger.log(`✅ Successfully recovered from backup: ${backup.name}`);
        return true;
      } catch (e) {
        logger.warn(`⚠️ Failed to recover from ${backup.name}:`, e.message);
        continue;
      }
    }

    logger.error('❌ All recovery attempts failed. Manual intervention required.');
    return false;
  }
}

export default DbBackup;
