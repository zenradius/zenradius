/**
 * License Heartbeat Service
 * Mengirim ping ringan sekali sehari ke registry lisensi ZenRadius
 * agar Developer mengetahui domain mana yang aktif memakai aplikasi.
 *
 * Data yang dikirim: domain, serial (jika ada), versi aplikasi, versi Node.
 * Tidak mengirim data pelanggan/keuangan apa pun.
 * Fail-silent: kegagalan jaringan tidak pernah mengganggu aplikasi.
 */
const fs = require('fs');
const path = require('path');
const { getSetting, saveSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');

const ENDPOINT = process.env.ZENRADIUS_REGISTRY_URL || 'https://api.license.zenradius.net/api/heartbeat';
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // minimal 20 jam antar kirim
const TIMEOUT_MS = 8000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', ''];

function readAppVersion() {
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', 'version.txt'), 'utf8').trim();
    if (v) return v.slice(0, 40);
  } catch (_) {}
  try { return String(require('../package.json').version || '').slice(0, 40); } catch (_) { return ''; }
}

function resolveDomain() {
  // Prioritas: app_url (yang diisi admin) → fallback hostname mesin
  const appUrl = String(getSetting('app_url', '') || '').trim();
  let host = '';
  if (appUrl) {
    try { host = new URL(appUrl.includes('://') ? appUrl : `https://${appUrl}`).hostname; } catch (_) {}
  }
  if (!host) {
    try { host = require('os').hostname(); } catch (_) {}
  }
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

async function sendHeartbeat({ force = false } = {}) {
  try {
    if (String(process.env.ZENRADIUS_HEARTBEAT || '').toLowerCase() === 'off') return { skipped: 'disabled' };

    const domain = resolveDomain();
    if (LOCAL_HOSTS.includes(domain) || /^[0-9.]+$/.test(domain) || !domain.includes('.')) {
      return { skipped: 'local_or_invalid_domain', domain };
    }

    const last = Number(getSetting('license_heartbeat_at', 0)) || 0;
    if (!force && Date.now() - last < MIN_INTERVAL_MS) return { skipped: 'too_soon' };

    const payload = {
      domain,
      serial: String(getSetting('domain_license_key', '') || '').trim().toUpperCase() || undefined,
      app_version: readAppVersion(),
      node_version: process.version
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `ZenRadius/${payload.app_version || 'unknown'}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
    } finally { clearTimeout(t); }

    if (!res.ok) {
      logger.debug(`[heartbeat] HTTP ${res.status}`);
      return { ok: false, status: res.status };
    }
    try { saveSettings({ license_heartbeat_at: Date.now() }); } catch (_) {}
    let data = null; try { data = await res.json(); } catch (_) {}
    logger.debug(`[heartbeat] terkirim untuk ${domain}`);
    return { ok: true, data };
  } catch (e) {
    logger.debug(`[heartbeat] gagal: ${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
}

/** Jadwalkan: kirim sekali saat start (setelah delay acak) + harian via cron. */
function scheduleHeartbeat(cron) {
  const startDelay = 60_000 + Math.floor(Math.random() * 120_000); // 1–3 menit setelah boot
  setTimeout(() => { sendHeartbeat().catch(() => {}); }, startDelay).unref?.();
  if (cron && typeof cron.schedule === 'function') {
    const minute = Math.floor(Math.random() * 60);
    const hour = 2 + Math.floor(Math.random() * 4); // 02:00–05:59 acak per instalasi
    cron.schedule(`${minute} ${hour} * * *`, () => { sendHeartbeat().catch(() => {}); });
  }
}

module.exports = { sendHeartbeat, scheduleHeartbeat, resolveDomain };
