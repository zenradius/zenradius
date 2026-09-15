/**
 * Instance Identity Service
 * Menghasilkan & menyimpan identitas unik instalasi (Instance ID) yang dipakai
 * untuk mengikat lisensi ke instalasi, bukan hanya ke domain/host.
 *
 * - Instance ID dibuat sekali (UUID acak) dan disimpan di data/instance.json.
 * - Machine fingerprint (hash machine-id / hostname / MAC) dipakai agar file
 *   instance.json tidak bisa begitu saja disalin ke server lain.
 * - Kode instalasi (Install Code) = 12 hex huruf besar, format XXXX-XXXX-XXXX,
 *   diturunkan dari instance_id + fingerprint. Kode inilah yang diberikan
 *   pelanggan saat order lisensi dan ikut dihitung dalam kunci lisensi.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('../config/logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'instance.json');

let cache = null;

function readMachineId() {
  const candidates = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch (_) { /* lanjut */ }
  }
  return '';
}

function readPrimaryMac() {
  try {
    const ifaces = os.networkInterfaces();
    const macs = [];
    for (const name of Object.keys(ifaces)) {
      for (const it of ifaces[name] || []) {
        if (!it.internal && it.mac && it.mac !== '00:00:00:00:00:00') macs.push(it.mac.toLowerCase());
      }
    }
    macs.sort();
    return macs[0] || '';
  } catch (_) { return ''; }
}

/** Sidik jari mesin: stabil selama server yang sama; berubah jika pindah mesin. */
function computeFingerprint() {
  const parts = [readMachineId(), os.hostname(), readPrimaryMac(), os.platform(), os.arch()].filter(Boolean);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function ensureLoaded() {
  if (cache) return cache;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) { data = null; }

  const fp = computeFingerprint();
  if (!data || typeof data.instance_id !== 'string' || data.instance_id.length < 16) {
    data = { instance_id: crypto.randomUUID(), fingerprint: fp, created_at: new Date().toISOString() };
    persist(data);
    logger.info(`[instance] Instance ID baru dibuat: ${shortId(data.instance_id)}`);
  } else if (data.fingerprint !== fp) {
    // File disalin dari mesin lain atau hardware berubah → instance dianggap baru.
    logger.warn('[instance] Sidik jari mesin berubah; Instance ID diperbarui (lisensi lama perlu diaktivasi ulang).');
    data = { instance_id: crypto.randomUUID(), fingerprint: fp, created_at: new Date().toISOString(), previous_instance_id: data.instance_id };
    persist(data);
  }
  cache = data;
  return cache;
}

function persist(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    logger.error(`[instance] Gagal menyimpan instance.json: ${e.message}`);
  }
}

function shortId(id) { return String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase(); }

function getInstanceId() { return ensureLoaded().instance_id; }
function getFingerprint() { return ensureLoaded().fingerprint; }

/**
 * Kode Instalasi yang ditampilkan ke pelanggan (dan dipakai generator lisensi).
 * Format: XXXX-XXXX-XXXX (12 hex uppercase) — cukup pendek untuk diketik via WA.
 */
function getInstallCode() {
  const d = ensureLoaded();
  const h = crypto.createHash('sha256').update(`${d.instance_id}|${d.fingerprint}`).digest('hex').toUpperCase();
  const raw = h.slice(0, 12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

module.exports = { getInstanceId, getFingerprint, getInstallCode, shortId };
