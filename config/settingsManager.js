const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

let runtimeSessionSecret = null;
function getSecureSessionSecretFallback() {
  if (!runtimeSessionSecret) {
    runtimeSessionSecret = crypto.randomBytes(32).toString('hex');
  }
  return runtimeSessionSecret;
}

function isPlaceholderSessionSecret(value) {
  if (value === undefined || value === null) return true;
  const normalized = String(value).trim();
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  return [
    'change-this-to-random-secret-key',
    'rahasia-portal-pelanggan-default-ganti-ini',
    'changeme',
    'secret',
    'default-secret',
    'example-secret'
  ].includes(lower);
}

// Cache untuk settings dengan timestamp
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_DURATION = 2000; // 2 detik

function parseBooleanSetting(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return Boolean(fallback);
}

// File system watcher untuk auto-reload settings
// PHASE 22: Development-only override. Unset in production → identical behavior
// (../settings.json). A local dev launcher may point this at an isolated copy.
const settingsPath = String(process.env.ZENRADIUS_SETTINGS_PATH || '').trim()
  ? path.resolve(process.env.ZENRADIUS_SETTINGS_PATH)
  : path.join(__dirname, '../settings.json');
let watcher = null;

// Helper untuk baca settings.json secara dinamis
function getSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) || {};

    const configuredSecret = String(process.env.SESSION_SECRET || settings.session_secret || '').trim();
    if (configuredSecret && !isPlaceholderSessionSecret(configuredSecret)) {
      settings.session_secret = configuredSecret;
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET/session_secret wajib dikonfigurasi dengan nilai unik non-placeholder pada production');
    } else {
      logger.warn('[settings] session_secret kosong atau placeholder; menggunakan secret runtime acak untuk development');
      settings.session_secret = getSecureSessionSecretFallback();
    }

    const fallbackTz = 'Asia/Jakarta';
    const tz = typeof settings.timezone === 'string' ? settings.timezone.trim() : '';

    if (!tz) {
      settings.timezone = fallbackTz;
      return settings;
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
      settings.timezone = tz;
    } catch (e) {
      settings.timezone = fallbackTz;
    }

    return settings;
  } catch (error) {
    logger.error(`[settings] Error reading settings.json: ${error.message}`);
    return {};
  }
}

// Helper untuk baca settings.json dengan cache
function getSettingsWithCache() {
  const now = Date.now();
  if (!settingsCache || (now - settingsCacheTime) > CACHE_DURATION) {
    settingsCache = getSettings();
    settingsCacheTime = now;
  }
  return settingsCache;
}

// Helper untuk mendapatkan nilai setting dengan fallback
function getSetting(key, defaultValue = null) {
  const settings = getSettingsWithCache();
  return settings[key] !== undefined ? settings[key] : defaultValue;
}

// Helper untuk mendapatkan multiple settings
function getSettingsByKeys(keys) {
  const settings = getSettingsWithCache();
  const result = {};
  keys.forEach(key => {
    result[key] = settings[key];
  });
  return result;
}

// File system watcher untuk auto-reload settings
function startSettingsWatcher() {
  try {
    // Hapus watcher lama jika ada
    if (watcher) {
      watcher.close();
    }
    
    // Buat watcher baru
    watcher = fs.watch(settingsPath, (eventType, filename) => {
      if (eventType !== 'change') return;
      // Di Windows `filename` sering null; hanya abaikan jika jelas bukan settings.json
      if (filename != null && filename !== 'settings.json') return;

      settingsCache = null;
      settingsCacheTime = 0;

      try {
        const s = getSettingsWithCache();
        const port = s.server_port ?? 4555;
        const host = s.server_host || 'localhost';
        const gurl = s.genieacs_url || '(tidak diatur)';
        const company = s.company_header || '(default)';
        logger.info(`[settings] settings.json dimuat ulang — port ${port}, host ${host}, company: ${company}, GenieACS: ${gurl}`);
      } catch (error) {
        logger.error(`[settings] Gagal memuat ulang settings.json: ${error.message}`);
      }
    });

    logger.info('[settings] Memantau perubahan settings.json');
  } catch (error) {
    logger.error(`[settings] Error starting settings watcher: ${error.message}`);
  }
}

// Mulai watcher saat modul dimuat
startSettingsWatcher();

// Menyimpan pengaturan ke settings.json
function saveSettings(newSettings) {
  try {
    const currentSettings = getSettings();
    // Phase 14: newSettings dapat berasal dari request body ({...req.body}).
    // Tolak key prototype-polluting agar payload seperti __proto__ tidak dapat
    // mencemari Object.prototype atau ditulis ke settings.json.
    const safeIncoming = {};
    for (const [k, v] of Object.entries(newSettings || {})) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      safeIncoming[k] = v;
    }
    const updatedSettings = { ...currentSettings, ...safeIncoming };
    fs.writeFileSync(settingsPath, JSON.stringify(updatedSettings, null, 2), 'utf-8');
    settingsCache = updatedSettings;
    settingsCacheTime = Date.now();
    return true;
  } catch (error) {
    logger.error(`[settings] Error saving settings.json: ${error.message}`);
    return false;
  }
}

/**
 * Helper untuk mendapatkan waktu sekarang dalam format lokal
 * sesuai timezone yang diatur di settings.json
 */
function getNowLocal() {
  const tz = getSetting('timezone', 'Asia/Jakarta');
  const now = new Date();
  const options = {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  const p = {};
  parts.forEach(part => p[part.type] = part.value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Helper untuk mendapatkan objek Date yang sudah disesuaikan dengan timezone di settings.
 * Mengembalikan objek Date yang "angkanya" sudah sesuai dengan waktu lokal.
 */
function getCurrentDateInTimezone() {
  const tz = getSetting('timezone', 'Asia/Jakarta');
  const now = new Date();
  
  // Ambil string format ISO lokal
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const p = {};
  parts.forEach(part => p[part.type] = part.value);
  
  // Buat objek Date baru dengan nilai lokal tersebut
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

/**
 * Mendapatkan info waktu sekarang (year, month, day, dll) dalam timezone yang diatur.
 */
function getCurrentTimeInfo() {
  const tz = getSetting('timezone', 'Asia/Jakarta');
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const p = {};
  parts.forEach(part => p[part.type] = part.value);
  
  return {
    year: parseInt(p.year),
    month: parseInt(p.month),
    day: parseInt(p.day),
    hour: parseInt(p.hour),
    minute: parseInt(p.minute),
    second: parseInt(p.second)
  };
}

/**
 * Mendapatkan string ISO-like tapi dalam waktu lokal (bukan UTC).
 * Berguna untuk timestamp log/backup.
 */
function getNowLocalISO() {
  const info = getCurrentTimeInfo();
  const pad = (n) => String(n).padStart(2, '0');
  return `${info.year}-${pad(info.month)}-${pad(info.day)}T${pad(info.hour)}:${pad(info.minute)}:${pad(info.second)}`;
}

/**
 * Memparse string tanggal (YYYY-MM-DD HH:mm:ss) menjadi objek Date
 * dengan asumsi string tersebut adalah waktu lokal sesuai setting timezone.
 */
function parseDateInTimezone(dateStr) {
  if (!dateStr) return null;
  const tz = getSetting('timezone', 'Asia/Jakarta');
  
  const date = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(date.getTime())) return null;

  const localDateStr = date.toLocaleString('en-US', { timeZone: tz, hour12: false });
  const localDate = new Date(localDateStr);
  const diff = localDate.getTime() - date.getTime();
  
  return new Date(date.getTime() - diff);
}

function formatDateLocal(date) {
  if (!date) return '-';
  const tz = getSetting('timezone', 'Asia/Jakarta');
  let d;
  if (typeof date === 'string') {
    d = parseDateInTimezone(date);
  } else {
    d = typeof date === 'number' ? new Date(date) : date;
  }
  if (!d || isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID', { timeZone: tz });
}

/**
 * Helper untuk memformat objek Date menjadi string waktu lokal (hanya Jam:Menit)
 */
function formatTimeLocal(date) {
  if (!date) return '-';
  const tz = getSetting('timezone', 'Asia/Jakarta');
  let d;
  if (typeof date === 'string') {
    d = parseDateInTimezone(date);
  } else {
    d = typeof date === 'number' ? new Date(date) : date;
  }
  if (!d || isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/**
 * Memastikan semua setting wajib ada di settings.json dengan default value.
 * Dijalankan saat startup aplikasi untuk migrasi/inisialisasi setting baru.
 */
function ensureDefaultSettings() {
  try {
    const currentSettings = getSettings();
    let needsSave = false;
    
    // Default settings yang wajib ada
    const defaultSettings = {
      // Branding default (dipakai footer & judul; admin bisa ubah dari /admin/settings)
      company_header: 'ZenRadius',
      footer_info: 'ZenRadius - All Rights Reserved',
      // WA defaults agar broadcast/pengingat tidak undefined di install baru
      wa_gateway_type: 'baileys',
      whatsapp_broadcast_delay: 5,
      whatsapp_auto_billing_enabled: false,
      whatsapp_billing_to_customer_enabled: true,
      fonnte_url: 'https://api.fonnte.com/send',
      http_wa_method: 'POST',
      http_wa_header_name: 'Authorization',
      // RADIUS Server settings (ditambahkan untuk update dari GitHub)
      radius_enabled: '0',
      radius_secret: 'secret123',
      radius_auth_port: '1812',
      radius_acct_port: '1813',
      radius_isolir_action: 'pool',
      radius_isolir_pool: 'isolir',
      radius_limit_simultaneous: '1',
      radius_default_rate_limit: '5M/10M',
      radius_isolir_rate_limit: '512k/512k',
      radius_isolir_ip_pool_enabled: '1',
      radius_isolir_ip_pool_start: '10.10.99.2',
      radius_isolir_ip_pool_end: '10.10.99.254',
      radius_ip_pool_enabled: '1',
      radius_ip_pool_start: '10.10.10.2',
      radius_ip_pool_end: '10.10.10.254',
      radius_framed_pool: 'pool-pppoe',
      radius_send_group: '0',

    };
    
    // Cek dan tambahkan setting yang belum ada
    for (const [key, defaultValue] of Object.entries(defaultSettings)) {
      if (currentSettings[key] === undefined) {
        currentSettings[key] = defaultValue;
        needsSave = true;
        logger.info(`[settings] Added missing setting: ${key} = ${defaultValue}`);
      }
    }
    
    // Simpan jika ada perubahan
    if (needsSave) {
      fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf-8');
      settingsCache = currentSettings;
      settingsCacheTime = Date.now();
      logger.info('[settings] settings.json updated with default RADIUS settings');
    }
    
    return needsSave;
  } catch (error) {
    logger.error(`[settings] Error ensuring default settings: ${error.message}`);
    return false;
  }
}

module.exports = {
  parseBooleanSetting,
  getSettings,
  getSettingsWithCache,
  getSetting,
  getSettingsByKeys,
  saveSettings,
  getNowLocal,
  formatDateLocal,
  formatTimeLocal,
  getCurrentDateInTimezone,
  getCurrentTimeInfo,
  getNowLocalISO,
  parseDateInTimezone,
  startSettingsWatcher,
  ensureDefaultSettings
};
