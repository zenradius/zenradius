/**
 * Domain License Service
 * Verifikasi lisensi ONLINE ke server lisensi resmi (zenradius-web).
 *
 * Skema v4 (production): KODE LISENSI sederhana `XXXX-XXXX-XXXX-XXXX`
 *   (contoh BG23-SJH2-HDGT-5582) yang terikat pada Kode Instalasi
 *   (XXXX-XXXX-XXXX-XXXX). Aplikasi mengirim (kode + kode instalasi) ke
 *   POST /api/verify dan server lisensi yang memutuskan valid/tidak.
 *
 * Karena validasi dilakukan di server, kode tidak dapat dipalsukan atau
 * dihitung sendiri meski seluruh source code diketahui.
 *
 * Kebijakan saat jaringan bermasalah:
 *   - Hasil verifikasi terakhir yang VALID tetap dipercaya selama
 *     LICENSE_OFFLINE_GRACE_DAYS (default 7 hari) sejak verifikasi sukses
 *     terakhir, agar gangguan internet singkat tidak mengunci aplikasi.
 *   - Bila belum pernah berhasil diverifikasi → lisensi dianggap tidak valid
 *     dan pengguna masuk masa tenggang (LICENSE_GRACE_DAYS).
 *
 * Skema legacy HMAC (v1/v2) dan token ZRL1 (v3) TIDAK LAGI DIDUKUNG.
 */
const { getSetting, saveSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const licenseInfo = require('../config/licenseInfo');
const licenseClient = require('./licenseClient');
const instanceIdentity = require('./instanceIdentityService');

const LOCAL_DOMAIN = 'local';

/** Cache in-memory hasil verifikasi terakhir (dipakai middleware sinkron). */
let cache = { code: null, host: null, valid: false, reason: null, at: 0, grace: null };
const CACHE_MS = 60 * 1000;                    // 1 menit antar panggilan jaringan
const GRACE_MS = licenseInfo.LICENSE_GRACE_DAYS * 24 * 60 * 60 * 1000;
/** Selama ini sejak verifikasi sukses terakhir, hasil 'valid' tetap dipercaya saat offline. */
const OFFLINE_GRACE_MS = (Number(process.env.LICENSE_OFFLINE_GRACE_DAYS) || 7) * 86400000;

const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
/** Bypass localhost hanya untuk pengembangan: NODE_ENV bukan production DAN flag eksplisit. */
const DEV_BYPASS = !IS_PRODUCTION && ['1', 'true', 'on'].includes(String(process.env.ZENRADIUS_DEV_LICENSE || '').toLowerCase());

/** Kode lisensi dinormalisasi: huruf besar, 4 grup × 4 karakter. */
function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length === 16) return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  return raw;
}
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
function isValidCodeFormat(code) { return CODE_RE.test(String(code || '').trim()); }

function normalizeDomain(input) {
  let value = String(input || '').trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  if (/^\[[^\]]+\](?::\d+)?$/.test(value)) value = value.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1');
  if (value !== '::1' && value.includes(':') && !/^[0-9a-f:]+$/i.test(value)) value = value.replace(/:\d+$/, '');
  return value;
}

function isLocalHost(host) { return ['localhost', '127.0.0.1', '::1', '0.0.0.0', ''].includes(host); }
function isIpAddress(host) { return /^[0-9.]+$/.test(host) || host.includes(':'); }
function isPrivateIp(host) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host);
}

/** Domain untuk keperluan laporan; localhost/IP privat dipetakan ke 'local'. */
function licenseDomainForHost(host) {
  const h = normalizeDomain(host);
  if (isLocalHost(h) || (isIpAddress(h) && isPrivateIp(h))) return LOCAL_DOMAIN;
  return h;
}

/** Masa tenggang GLOBAL per instalasi (tidak direset saat host berubah). */
function getGraceState(host) {
  const startedAt = Number(getSetting('license_grace_started_at', 0)) || 0;
  const now = Date.now();
  if (!startedAt) {
    try { saveSettings({ license_grace_started_at: now, license_grace_host: host }); } catch (e) { /* abaikan */ }
    return { inGrace: true, daysLeft: licenseInfo.LICENSE_GRACE_DAYS, endsAt: now + GRACE_MS };
  }
  const endsAt = startedAt + GRACE_MS;
  const daysLeft = Math.max(0, Math.ceil((endsAt - now) / 86400000));
  return { inGrace: now < endsAt, daysLeft, endsAt };
}

function clearGrace() {
  const startedAt = Number(getSetting('license_grace_started_at', 0)) || 0;
  if (startedAt) {
    try { saveSettings({ license_grace_started_at: 0, license_grace_host: '' }); } catch (e) { /* abaikan */ }
  }
}

/** Status registry yang disimpan heartbeat. */
function getRegistryState() {
  return {
    status: String(getSetting('license_registry_status', '') || ''),
    lastOkAt: Number(getSetting('license_registry_ok_at', 0)) || 0,
    activatedAt: Number(getSetting('license_activated_at', 0)) || 0,
  };
}

/** Dipanggil heartbeat setelah respons server berhasil. */
function recordRegistryResult({ status }) {
  const patch = { license_registry_ok_at: Date.now() };
  if (status) patch.license_registry_status = String(status);
  try { saveSettings(patch); } catch (_) { /* abaikan */ }
  cache.at = 0; // paksa evaluasi ulang
}

/** Simpan hasil verifikasi ke pengaturan agar bertahan setelah restart. */
function persistResult(res) {
  try {
    const patch = {
      license_last_valid: res.valid ? 1 : 0,
      license_last_reason: res.reason || '',
      license_last_verified_at: res.verifiedAt || Date.now(),
      license_last_verify_ok: res.networkOk ? 1 : 0,
    };
    saveSettings(patch);
  } catch (_) { /* abaikan */ }
}

/**
 * Simpan origin server lisensi penerbit dari respons (setting `license_web_url`)
 * supaya terisi otomatis. HANYA diisi bila masih kosong — pilihan manual admin
 * tidak pernah ditimpa.
 */
function storeServerOrigin(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u || !/^https?:\/\//i.test(u)) return;
  const current = String(getSetting('license_web_url', '') || '').trim();
  if (current) return; // sudah diisi manual → biarkan
  try { saveSettings({ license_web_url: u }); } catch (_) { /* abaikan */ }
}

/** Origin server lisensi penerbit (untuk ditampilkan). */
function getServerOrigin() {
  const saved = String(getSetting('license_server_origin', '') || '').trim().replace(/\/+$/, '');
  if (saved) return saved;
  const manual = String(getSetting('license_web_url', '') || '').trim().replace(/\/+$/, '');
  if (manual) return manual;
  return licenseClient.baseUrl();
}

/**
 * Verifikasi online (async).
 * @param {{code?:string, host?:string, installCode?:string}} opts
 */
async function verifyOnline({ code, host, installCode } = {}) {
  const licenseCode = normalizeCode(code !== undefined ? code : getSetting('domain_license_key', ''));
  const ic = licenseCode ? (installCode || instanceIdentity.getInstallCode()) : '';
  if (!licenseCode) return { valid: false, reason: 'empty', verifiedAt: Date.now(), networkOk: true };
  if (!isValidCodeFormat(licenseCode)) return { valid: false, reason: 'format', verifiedAt: Date.now(), networkOk: true };

  const r = await licenseClient.verifyLicense({ code: licenseCode, installCode: ic, domain: host });
  if (!r.ok) {
    // Jaringan bermasalah: pulihkan hasil sukses terakhir bila masih dalam OFFLINE_GRACE.
    const lastOk = Number(getSetting('license_last_verified_at', 0)) || 0;
    const lastValid = String(getSetting('license_last_valid', '0')) === '1';
    const withinGrace = lastOk && (Date.now() - lastOk) < OFFLINE_GRACE_MS;
    if (lastValid && withinGrace) {
      return { valid: true, reason: null, offline: true, verifiedAt: lastOk, networkOk: false };
    }
    return { valid: false, reason: 'offline', verifiedAt: Date.now(), networkOk: false };
  }

  const res = {
    valid: r.valid === true,
    reason: r.reason || null,
    grace: r.grace === true,
    grace_end: r.grace_end || null,
    expires_at: r.expires_at === undefined ? null : r.expires_at,
    days_left: r.days_left === undefined ? null : r.days_left,
    server_url: r.server_url || null,
    verifiedAt: Date.now(),
    networkOk: true,
  };
  // Origin server lisensi penerbit → simpan & isi otomatis di Pengaturan.
  if (res.server_url) {
    storeServerOrigin(res.server_url);
    try { saveSettings({ license_server_origin: res.server_url }); } catch (_) { /* abaikan */ }
  }
  persistResult(res);
  return res;
}

/** Versi async untuk pemakaian langsung (admin menyimpan kode lisensi). */
async function verifyLicenseForHost(host, code) {
  const cleanHost = licenseDomainForHost(host);
  return verifyOnline({ code, host: cleanHost });
}

/**
 * Cek lisensi untuk request saat ini (SINKRON) berdasarkan cache.
 *
 * Middleware Express bersifat sinkron, jadi hasil verifikasi jaringan dipakai
 * dari cache. Bila cache kedaluwarsa, penyegaran dijalankan di latar belakang.
 */
function checkRequestLicense(req) {
  const rawHost = normalizeDomain(req.hostname || req.headers.host);
  const host = licenseDomainForHost(rawHost);
  const code = normalizeCode(getSetting('domain_license_key', ''));
  const now = Date.now();
  const installCode = instanceIdentity.getInstallCode();

  // Bypass hanya di mode pengembangan eksplisit (bukan production).
  if (DEV_BYPASS && isLocalHost(rawHost)) {
    cache = { code, host, valid: true, reason: null, at: now, grace: null };
    return { valid: true, host, rawHost, dev: true, installCode };
  }

  if (cache.code === code && cache.host === host && now - cache.at < CACHE_MS) {
    return { valid: cache.valid, reason: cache.reason || null, host, rawHost, grace: cache.grace || null, installCode };
  }

  // Paksa penyegaran di latar belakang (tidak memblokir permintaan).
  scheduleRevalidate({ code, host, installCode });

  // Nilai sementara: pakai hasil sukses terakhir bila masih dalam OFFLINE_GRACE.
  let valid = cache.code === code ? cache.valid : false;
  let reason = cache.code === code ? cache.reason : null;
  if (!valid) {
    const lastOk = Number(getSetting('license_last_verified_at', 0)) || 0;
    const lastValid = String(getSetting('license_last_valid', '0')) === '1';
    const savedCode = normalizeCode(getSetting('domain_license_key', ''));
    if (lastValid && savedCode === code && lastOk && (now - lastOk) < OFFLINE_GRACE_MS) {
      valid = true; reason = null;
    }
  }

  let grace = null;
  if (valid) {
    clearGrace();
  } else {
    grace = getGraceState(host);
    logger.warn(`[license] Lisensi belum/tidak valid (${reason || 'belum diverifikasi'}) untuk "${host}"; masa tenggang ${grace.inGrace ? grace.daysLeft + ' hari tersisa' : 'berakhir'}`);
  }
  cache = { code, host, valid, reason, at: now, grace };
  return { valid, reason, host, rawHost, grace, installCode };
}

/** Debounce sederhana agar tidak membanjiri server lisensi. */
let revalidating = false;
function scheduleRevalidate({ code, host, installCode }) {
  if (revalidating) return;
  revalidating = true;
  verifyOnline({ code, host, installCode })
    .then((res) => {
      cache = { code, host, valid: res.valid, reason: res.reason, at: Date.now(), grace: cache.grace };
      if (res.valid) clearGrace();
    })
    .catch(() => {})
    .finally(() => { revalidating = false; });
}

/** Ringkasan lisensi tersimpan (untuk UI settings & heartbeat). */
function getStoredLicenseInfo() {
  const raw = String(getSetting('domain_license_key', '') || '').trim();
  if (!raw) return { present: false, scheme: null, code: null };
  const code = normalizeCode(raw);
  if (!isValidCodeFormat(code)) return { present: true, scheme: 'invalid', code: null };
  return {
    present: true,
    scheme: 'v4',
    code,
    lastValid: String(getSetting('license_last_valid', '0')) === '1',
    lastReason: String(getSetting('license_last_reason', '') || ''),
    lastVerifiedAt: Number(getSetting('license_last_verified_at', 0)) || 0,
  };
}

/** Status lisensi tanpa request (untuk cron/background job). */
function getBackgroundLicenseState() {
  const savedHost = String(getSetting('domain_license_host', '') || getSetting('public_base_url', '') || '').trim();
  const host = savedHost ? licenseDomainForHost(savedHost) : LOCAL_DOMAIN;
  const code = normalizeCode(getSetting('domain_license_key', ''));
  const lastOk = Number(getSetting('license_last_verified_at', 0)) || 0;
  const lastValid = String(getSetting('license_last_valid', '0')) === '1';
  const withinGrace = lastOk && (Date.now() - lastOk) < OFFLINE_GRACE_MS;

  if (code && lastValid && withinGrace) return { valid: true, host, blocked: false };
  if (DEV_BYPASS) return { valid: true, host, blocked: false };

  const grace = getGraceState(host);
  return { valid: false, host, grace, blocked: !grace.inGrace };
}

/** Untuk cron: true jika job berbayar boleh berjalan (lisensi valid atau masih tenggang). */
function isBackgroundAllowed() {
  if (DEV_BYPASS) return true;
  try { return !getBackgroundLicenseState().blocked; } catch (e) {
    logger.error(`[license] Gagal memeriksa lisensi background: ${e.message}`);
    return false;
  }
}

/** Pesan manusiawi untuk alasan lisensi tidak valid. */
function describeReason(reason, host) {
  const target = host === LOCAL_DOMAIN ? 'instalasi lokal ini' : `instalasi di ${host}`;
  switch (reason) {
    case 'empty':   return 'Kode lisensi belum diisi. Masukkan kode lisensi pada Pengaturan → Lisensi.';
    case 'format':  return 'Format kode lisensi tidak valid. Contoh yang benar: BG23-SJH2-HDGT-5582.';
    case 'not_found': return 'Kode lisensi tidak ditemukan di server lisensi. Periksa kembali penulisannya.';
    case 'install_mismatch': return 'Kode lisensi terikat ke Kode Instalasi lain — tidak cocok dengan instalasi ini. Minta penerbitan ulang dengan Kode Instalasi yang benar.';
    case 'suspended': return 'Lisensi ini telah dinonaktifkan oleh Developer.';
    case 'expired': return 'Lisensi ini telah kedaluwarsa.';
    case 'grace_expired': return 'Masa aktivasi lisensi telah berakhir. Hubungi Developer.';
    case 'offline': return `Server tidak dapat menghubungi layanan lisensi (${target}). Periksa koneksi internet server lalu coba lagi.`;
    default: return 'Lisensi tidak valid.';
  }
}

/**
 * Middleware: blokir akses jika lisensi tidak valid.
 * Route settings & login tetap diizinkan agar admin bisa memasukkan kode.
 * Selama masa tenggang (LICENSE_GRACE_DAYS) akses tetap diizinkan.
 */
function requireDomainLicense(options = {}) {
  const allowPaths = options.allowPaths || [
    '/admin/login', '/admin/logout', '/admin/settings', '/api/settings',
    '/license', '/css', '/js', '/img', '/manifest', '/sw.js', '/favicon'
  ];

  return (req, res, next) => {
    res.locals.licenseInfo = licenseInfo;
    const isAllowed = allowPaths.some(p => req.path.startsWith(p));

    const result = checkRequestLicense(req);
    res.locals.licenseValid = result.valid;
    res.locals.licenseReason = result.reason || null;
    res.locals.licenseHost = result.host;
    res.locals.licenseInstallCode = result.installCode;
    res.locals.licenseGrace = (!result.valid && result.grace && result.grace.inGrace) ? result.grace : null;

    if (isAllowed || result.valid) return next();
    if (res.locals.licenseGrace) return next();

    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(402).json({ error: 'Lisensi tidak valid', reason: result.reason || null, host: result.host, installCode: result.installCode });
    }
    return res.status(402).render('license-required', {
      domain: result.host,
      installCode: result.installCode,
      hasKey: Boolean(getSetting('domain_license_key', '')),
      reason: result.reason || null,
      reasonText: result.reason ? describeReason(result.reason, result.host) : '',
      licenseInfo,
      licenseWebUrl: String(getSetting('license_web_url', '') || '').trim(),
      layout: false
    });
  };
}

module.exports = {
  normalizeDomain, normalizeCode, isValidCodeFormat, licenseDomainForHost,
  verifyOnline, verifyLicenseForHost, checkRequestLicense, requireDomainLicense,
  getBackgroundLicenseState, isBackgroundAllowed, getStoredLicenseInfo,
  recordRegistryResult, getRegistryState, describeReason, scheduleRevalidate,
  getServerOrigin,
  getInstallCode: () => instanceIdentity.getInstallCode(),
  LOCAL_DOMAIN, licenseInfo,
};
