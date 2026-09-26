/** Service: Backup & Recovery System */
const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');
const { getSetting, getCurrentDateInTimezone, getNowLocalISO } = require('../config/settingsManager');

const projectRoot = path.join(__dirname, '..');
const backupDir = path.join(projectRoot, 'backups');
const settingsPath = path.join(projectRoot, 'settings.json');

/** Path file database live — mengikuti resolusi config/database.js (termasuk override ZENRADIUS_DB_PATH). */
function getLiveDbPath() {
  try {
    const liveDb = require('../config/database');
    if (liveDb && liveDb.dbPath) return liveDb.dbPath;
  } catch (e) { /* fallback di bawah */ }
  return path.join(projectRoot, 'database', 'zenradius.db');
}

if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
  logger.info('[Backup] Created backup directory');
}

/**
 * Generate timestamp untuk nama file backup
 */
function getBackupTimestamp() {
  const now = getCurrentDateInTimezone();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/** Hapus file sidecar SQLite (-wal/-shm/-journal) yang tertinggal di samping file backup. */
function removeSidecarFiles(filePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      if (fs.existsSync(filePath + suffix)) fs.unlinkSync(filePath + suffix);
    } catch (e) {
      logger.warn(`[Backup] Gagal menghapus sidecar ${path.basename(filePath + suffix)}: ${e.message}`);
    }
  }
}

function isSidecarFile(fileName) {
  return /\.(db|sqlite)-(wal|shm|journal)$/i.test(fileName);
}

/**
 * Verifikasi file SQLite: integrity_check harus 'ok'. Dibuka readonly dan
 * dipaksa journal_mode=DELETE agar tidak meninggalkan -wal/-shm.
 */
function verifyBackupFile(filePath) {
  try {
    const Database = require('better-sqlite3');
    const verifyDb = new Database(filePath, { fileMustExist: true });
    let result;
    try {
      verifyDb.pragma('journal_mode = DELETE');
      result = verifyDb.pragma('integrity_check');
    } finally {
      verifyDb.close();
    }
    removeSidecarFiles(filePath);
    const ok = Array.isArray(result) && result.length === 1 && result[0].integrity_check === 'ok';
    return { ok, error: ok ? null : 'integrity_check tidak melaporkan ok' };
  } catch (e) {
    removeSidecarFiles(filePath);
    return { ok: false, error: e.message };
  }
}

/** Backup database SQLite (snapshot konsisten via better-sqlite3 backup API). */
async function backupDatabase() {
  try {
    const timestamp = getBackupTimestamp();
    const backupFileName = `zenradius_db_${timestamp}.db`;
    const backupFilePath = path.join(backupDir, backupFileName);

    const liveDb = require('../config/database');
    if (liveDb && typeof liveDb.backup === 'function' && liveDb.open) {
      await liveDb.backup(backupFilePath);
    } else {
      // Fallback: checkpoint lalu salin file mentah.
      try { liveDb.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {
        logger.warn(`[Backup] WAL checkpoint sebelum backup gagal (lanjut backup): ${e.message}`);
      }
      fs.copyFileSync(getLiveDbPath(), backupFilePath);
    }

    const verify = verifyBackupFile(backupFilePath);
    const verified = verify.ok;
    const verifyError = verify.error;
    if (!verified) {
      logger.error(`[Backup] Verifikasi integritas backup GAGAL untuk ${backupFileName}: ${verifyError}`);
    }

    const stats = fs.statSync(backupFilePath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.info(`[Backup] Database backup created: ${backupFileName} (${sizeKB} KB, verified=${verified})`);

    // Kirim backup database ke Telegram jika Telegram bot aktif
    try {
      const { sendBackupToTelegram } = require('./telegramBot');
      sendBackupToTelegram(backupFilePath);
    } catch (teleErr) {
      logger.warn(`[Backup] Gagal meneruskan file backup ke bot Telegram: ${teleErr.message}`);
    }

    return {
      success: true,
      fileName: backupFileName,
      size: stats.size,
      timestamp: getNowLocalISO(),
      verified,
      verifyError: verified ? null : verifyError
    };
  } catch (e) {
    logger.error(`[Backup] Failed to backup database: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Backup settings.json
 */
function backupSettings() {
  try {
    const timestamp = getBackupTimestamp();
    const backupFileName = `settings_${timestamp}.json`;
    const backupFilePath = path.join(backupDir, backupFileName);

    fs.copyFileSync(settingsPath, backupFilePath);

    const stats = fs.statSync(backupFilePath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.info(`[Backup] Settings backup created: ${backupFileName} (${sizeKB} KB)`);

    return {
      success: true,
      fileName: backupFileName,
      size: stats.size,
      timestamp: getNowLocalISO()
    };
  } catch (e) {
    logger.error(`[Backup] Failed to backup settings: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Backup semua (database + settings)
 */
async function backupAll() {
  const dbResult = await backupDatabase();
  const settingsResult = backupSettings();

  return {
    database: dbResult,
    settings: settingsResult,
    timestamp: getNowLocalISO()
  };
}

/**
 * Restore database dari backup
 */
async function restoreDatabase(backupFileName) {
  try {
    const safeName = path.basename(String(backupFileName || ''));
    const backupFilePath = path.resolve(backupDir, safeName);

    if (!safeName || path.dirname(backupFilePath) !== path.resolve(backupDir) || !fs.existsSync(backupFilePath)) {
      return {
        success: false,
        error: `Backup file not found: ${backupFileName}`
      };
    }

    // Tolak file yang bukan SQLite valid sebelum menimpa database live.
    const verify = verifyBackupFile(backupFilePath);
    if (!verify.ok) {
      return {
        success: false,
        error: `File backup tidak lolos integrity_check: ${verify.error}`
      };
    }

    const preRestoreBackup = await backupDatabase();
    if (!preRestoreBackup.success) {
      logger.warn('[Backup] Failed to create pre-restore backup');
    }

    const dbPath = getLiveDbPath();
    let restoredVia = 'copy';
    try {
      // Utamakan SQLite Online Backup API dari file backup -> database live.
      // Aman terhadap koneksi yang sedang terbuka (WAL/mmap) di semua OS,
      // berbeda dengan copyFile yang bisa gagal/korup saat file sedang dipakai.
      const Database = require('better-sqlite3');
      const src = new Database(backupFilePath, { readonly: true, fileMustExist: true });
      try {
        await src.backup(dbPath);
      } finally {
        src.close();
      }
      removeSidecarFiles(backupFilePath);
      restoredVia = 'sqlite-backup-api';
    } catch (apiErr) {
      logger.warn(`[Backup] Restore via backup API gagal (${apiErr.message}); fallback ke copyFile.`);
      try {
        const liveDb = require('../config/database');
        if (liveDb && liveDb.open) liveDb.pragma('wal_checkpoint(TRUNCATE)');
      } catch (e) {
        logger.warn(`[Backup] WAL checkpoint sebelum restore gagal: ${e.message}`);
      }
      fs.copyFileSync(backupFilePath, dbPath);
      removeSidecarFiles(dbPath);
    }

    const stats = fs.statSync(dbPath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.warn(`[Backup] Database restored from: ${safeName} (${sizeKB} KB, via ${restoredVia}). Restart aplikasi diperlukan agar koneksi memakai data hasil restore.`);

    return {
      success: true,
      fileName: safeName,
      size: stats.size,
      timestamp: getNowLocalISO(),
      preRestoreBackup: preRestoreBackup.fileName,
      restartRequired: true
    };
  } catch (e) {
    logger.error(`[Backup] Failed to restore database: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Restore settings dari backup
 */
function restoreSettings(backupFileName) {
  try {
    const backupFilePath = path.join(backupDir, backupFileName);

    if (!fs.existsSync(backupFilePath)) {
      return {
        success: false,
        error: `Backup file not found: ${backupFileName}`
      };
    }

    const preRestoreBackup = backupSettings();
    if (!preRestoreBackup.success) {
      logger.warn('[Backup] Failed to create pre-restore backup');
    }

    fs.copyFileSync(backupFilePath, settingsPath);

    const stats = fs.statSync(settingsPath);
    const sizeKB = Math.round(stats.size / 1024);

    logger.info(`[Backup] Settings restored from: ${backupFileName} (${sizeKB} KB)`);

    return {
      success: true,
      fileName: backupFileName,
      size: stats.size,
      timestamp: getNowLocalISO(),
      preRestoreBackup: preRestoreBackup.fileName
    };
  } catch (e) {
    logger.error(`[Backup] Failed to restore settings: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Daftar semua backup yang tersedia
 */
function listBackups() {
  try {
    const files = fs.readdirSync(backupDir);
    const backups = [];

    for (const file of files) {
      if (isSidecarFile(file)) continue; // artefak SQLite, bukan backup
      const filePath = path.join(backupDir, file);
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;

      let backupDate = null;
      let backupType = null;

      if ((file.startsWith('zenradius_db_') || file.startsWith('billing_db_')) && file.endsWith('.db')) {
        backupType = 'database';
        const timestamp = file.replace('zenradius_db_', '').replace('billing_db_', '').replace('.db', '');
        backupDate = parseBackupTimestamp(timestamp);
      } else if (file.startsWith('settings_') && file.endsWith('.json')) {
        backupType = 'settings';
        const timestamp = file.replace('settings_', '').replace('.json', '');
        backupDate = parseBackupTimestamp(timestamp);
      }

      backups.push({
        fileName: file,
        type: backupType,
        size: stats.size,
        sizeKB: Math.round(stats.size / 1024),
        created: stats.birthtime,
        createdDate: backupDate,
        modified: stats.mtime
      });
    }

    backups.sort((a, b) => b.created - a.created);

    return {
      success: true,
      backups: backups,
      total: backups.length
    };
  } catch (e) {
    logger.error(`[Backup] Failed to list backups: ${e.message}`);
    return {
      success: false,
      error: e.message,
      backups: []
    };
  }
}

/**
 * Parse timestamp dari nama file backup
 */
function parseBackupTimestamp(timestamp) {
  try {

    const [datePart, timePart] = timestamp.split('_');
    const year = datePart.substring(0, 4);
    const month = datePart.substring(4, 6);
    const day = datePart.substring(6, 8);
    const hours = timePart.substring(0, 2);
    const minutes = timePart.substring(2, 4);
    const seconds = timePart.substring(4, 6);

    return new Date(year, month - 1, day, hours, minutes, seconds);
  } catch (e) {
    return null;
  }
}

/**
 * Hapus backup lama berdasarkan retention policy
 */
function cleanupOldBackups(retentionDays = 30) {
  try {
    const result = listBackups();
    if (!result.success) {
      return result;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;
    const deletedFiles = [];

    for (const backup of result.backups) {
      if (backup.created < cutoffDate) {
        const filePath = path.join(backupDir, backup.fileName);
        fs.unlinkSync(filePath);
        deletedCount++;
        deletedFiles.push(backup.fileName);
        logger.info(`[Backup] Deleted old backup: ${backup.fileName}`);
      }
    }

    return {
      success: true,
      deletedCount,
      deletedFiles,
      retentionDays
    };
  } catch (e) {
    logger.error(`[Backup] Failed to cleanup old backups: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Cek kapasitas backup dan hapus jika perlu
 */
function checkBackupCapacity(maxSizeMB = 500) {
  try {
    const result = listBackups();
    if (!result.success) {
      return result;
    }

    const totalSize = result.backups.reduce((sum, backup) => sum + backup.size, 0);
    const totalSizeMB = totalSize / (1024 * 1024);

    if (totalSizeMB > maxSizeMB) {
      logger.warn(`[Backup] Backup size (${totalSizeMB.toFixed(2)} MB) exceeds limit (${maxSizeMB} MB)`);

      const sortedBackups = [...result.backups].sort((a, b) => a.created - b.created);
      let deletedCount = 0;

      for (const backup of sortedBackups) {
        if (totalSizeMB <= maxSizeMB * 0.8) {
          break;
        }

        const filePath = path.join(backupDir, backup.fileName);
        fs.unlinkSync(filePath);
        totalSizeMB -= backup.size / (1024 * 1024);
        deletedCount++;
        logger.info(`[Backup] Deleted backup for capacity: ${backup.fileName}`);
      }

      return {
        success: true,
        action: 'cleanup',
        deletedCount,
        totalSizeMB: totalSizeMB.toFixed(2),
        maxSizeMB
      };
    }

    return {
      success: true,
      action: 'none',
      totalSizeMB: totalSizeMB.toFixed(2),
      maxSizeMB
    };
  } catch (e) {
    logger.error(`[Backup] Failed to check backup capacity: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

/**
 * Jadwal backup otomatis
 */
function scheduleAutoBackup() {
  const nodeCron = require('node-cron');
  const enabled = getSetting('auto_backup_enabled', true);
  const schedule = getSetting('auto_backup_schedule', '0 2 */7 * *');

  if (!enabled) {
    logger.info('[Backup] Auto backup disabled');
    return;
  }

  nodeCron.schedule(schedule, async () => {
    logger.info('[Backup] Starting scheduled backup...');
    try {
      const result = await backupAll();
      if (result.database.success && result.settings.success) {
        logger.info(`[Backup] Scheduled backup completed successfully: ${result.database.fileName}`);
      } else {
        logger.error(`[Backup] Scheduled backup failed: ${result.database.error || result.settings.error || 'unknown'}`);
      }
    } catch (e) {
      logger.error(`[Backup] Scheduled backup error: ${e.message}`);
    }
  });

  logger.info(`[Backup] Auto backup scheduled: ${schedule}`);
}

module.exports = {
  backupDatabase,
  backupSettings,
  backupAll,
  restoreDatabase,
  restoreSettings,
  listBackups,
  cleanupOldBackups,
  checkBackupCapacity,
  scheduleAutoBackup,
  verifyBackupFile
};
