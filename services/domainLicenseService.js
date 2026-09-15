/**
 * Domain License Service
 * Verifikasi lisensi seumur hidup berbasis domain + identitas instalasi (HMAC-SHA256).
 * Kunci dihasilkan oleh generator di https://licensi.zenradius.net
 * dengan Master Secret yang sama dengan MASTER_SECRET di bawah.
 *
 * Skema kunci (v2): HMAC(domain + '|' + installCode) → terikat ke instalasi;
 *   tidak bisa dipindah ke server lain meski domain sama.
 * Skema lama (v1): HMAC(domain) → tetap diterima untuk kompatibilitas pelanggan
 *   yang sudah memiliki kode; dapat dimatikan dengan env LICENSE_ACCEPT_LEGACY=off.
 * Instalasi lokal tanpa domain: pakai domain khusus 'local' (kunci v2 saja).
 */
const crypto = require('crypto');
const { getSetting, saveSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const licenseInfo = require('../config/licenseInfo');
const instanceIdentity = require('./instanceIdentityService');

// Secret master yang di-hardcode langsung demi kepraktisan & keamanan internal
const MASTER_SECRET = '@Du4du4220215@';
const LOCAL_DOMAIN = 'local';

let cache = { key: null, host: null, valid: false, at: 0 };
const CACHE_MS = 5000;
const GRACE_MS = licenseInfo.LICENSE_GRACE_DAYS * 24 * 60 * 60 * 1000;

const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
/** Bypass localhost hanya untuk pengembangan: NODE_ENV bukan production DAN flag eksplisit. */
const DEV_BYPASS = !IS_PRODUCTION && ['1', 'true', 'on'].includes(String(process.env.ZENRADIUS_DEV_LICENSE || '').toLowerCase());
const ACCEPT_LEGACY = String(process.env.LICENSE_ACCEPT_LEGACY || 'on').toLowerCase() !== 'off';

/**
 * Masa tenggang GLOBAL per instalasi: dicatat sekali saat lisensi pertama kali
 * terdeteksi tidak valid dan TIDAK direset saat host/IP berubah.
 */
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

function normalizeDomain(input) {
  let value = String(input || '').trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  if (/^\[[^\]]+\](?::\d+)?$/.test(value)) value = value.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1');
  // Bare IPv6 seperti ::1 tidak memiliki port yang bisa dibuang.
  if (value !== '::1' && value.includes(':') && !/^[0-9a-f:]+$/i.test(value)) value = value.replace(/:\d+$/, '');
  return value;
}

function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0', ''].includes(host);
}

function isIpAddress(host) {
  return /^[0-9.]+$/.test(host) || host.includes(':');
}

function isPrivateIp(host) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host) || host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host);
}

/**
 * Domain yang dipakai untuk menghitung lisensi dari host request.
 * Localhost dan IP privat dipetakan ke 'local' agar satu kode mencakup semua
 * cara akses lokal (localhost, 192.168.x.x, 10.x.x.x, ...).
 */
function licenseDomainForHost(host) {
  const h = normalizeDomain(host);
  if (isLocalHost(h) || (isIpAddress(h) && isPrivateIp(h))) return LOCAL_DOMAIN;
  return h;
}

function formatKey(hex16) {
  return `${hex16.substring(0, 4)}-${hex16.substring(4, 8)}-${hex16.substring(8, 12)}-${hex16.substring(12, 16)}`;
}

function hmac16(input) {
  return crypto.createHmac('sha256', MASTER_SECRET).update(input).digest('hex').toUpperCase().substring(0, 16);
}

/** Kunci v1 (legacy): hanya domain. */
function computeSignature(domain) {
  return formatKey(hmac16(domain));
}

/** Kunci v2: domain + kode instalasi. */
function computeSignatureV2(domain, installCode) {
  return formatKey(hmac16(`${domain}|${String(installCode || '').toUpperCase()}`));
}

function verifyLicense(domain, licenseKey) {
  if (!MASTER_SECRET) return { valid: false, reason: 'secret_missing' };
  const clean = licenseDomainForHost(domain);
  const key = String(licenseKey || '').trim().toUpperCase();
  if (!clean || !/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) return { valid: false, reason: 'format', domain: clean };

  const installCode = instanceIdentity.getInstallCode();
  if (computeSignatureV2(clean, installCode) === key) return { valid: true, reason: null, domain: clean, scheme: 'v2' };
  // Legacy: hanya untuk domain sungguhan (bukan 'local'), agar instalasi lokal wajib kunci terikat instalasi.
  if (ACCEPT_LEGACY && clean !== LOCAL_DOMAIN && computeSignature(clean) === key) return { valid: true, reason: null, domain: clean, scheme: 'v1' };
  return { valid: false, reason: 'mismatch', domain: clean };
}

/**
 * Cek lisensi untuk request saat ini (berdasarkan Host header).
 */
function checkRequestLicense(req) {
  const rawHost = normalizeDomain(req.hostname || req.headers.host);
  const host = licenseDomainForHost(rawHost);
  const licenseKey = getSetting('domain_license_key', '');
  const now = Date.now();

  if (cache.key === licenseKey && cache.host === host && now - cache.at < CACHE_MS) {
    return { valid: cache.valid, host, rawHost, grace: cache.grace || null, installCode: instanceIdentity.getInstallCode() };
  }

  // Bypass hanya di mode pengembangan eksplisit (bukan production).
  if (DEV_BYPASS && isLocalHost(rawHost)) {
    cache = { key: licenseKey, host, valid: true, at: now, grace: null };
    return { valid: true, host, rawHost, dev: true, installCode: instanceIdentity.getInstallCode() };
  }

  const result = verifyLicense(rawHost, licenseKey);
  let grace = null;
  if (result.valid) {
    clearGrace();
  } else {
    grace = getGraceState(host);
    logger.warn(`[license] Lisensi tidak valid untuk "${host}"${rawHost !== host ? ` (akses via ${rawHost})` : ''}; masa tenggang ${grace.inGrace ? grace.daysLeft + ' hari tersisa' : 'berakhir'}`);
  }
  cache = { key: licenseKey, host, valid: result.valid, at: now, grace };
  return { ...result, host, rawHost, grace, installCode: instanceIdentity.getInstallCode() };
}

/**
 * Status lisensi tanpa request (untuk cron/background job).
 * Memakai domain yang tersimpan saat aktivasi; jika tidak ada → 'local'.
 */
function getBackgroundLicenseState() {
  const savedHost = String(
    getSetting('domain_license_host', '') ||
    getSetting('public_base_url', '') ||
    getSetting('app_url', '') ||
    ''
  ).trim();
  const host = savedHost ? licenseDomainForHost(savedHost) : LOCAL_DOMAIN;
  const key = getSetting('domain_license_key', '');
  const result = verifyLicense(host, key);
  if (result.valid) return { valid: true, host, blocked: false };
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

/**
 * Middleware: blokir akses jika lisensi tidak valid.
 * Route settings & login tetap diizinkan agar admin bisa memasukkan lisensi.
 * Selama masa tenggang (LICENSE_GRACE_DAYS) akses tetap diizinkan dan
 * res.locals.licenseGrace diisi agar layout dapat menampilkan banner peringatan.
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
    res.locals.licenseHost = result.host;
    res.locals.licenseInstallCode = result.installCode;
    res.locals.licenseGrace = (!result.valid && result.grace && result.grace.inGrace) ? result.grace : null;

    if (isAllowed || result.valid) return next();
    if (res.locals.licenseGrace) return next();

    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(402).json({ error: 'Lisensi tidak valid', domain: result.host, installCode: result.installCode });
    }
    return res.status(402).render('license-required', {
      domain: result.host,
      installCode: result.installCode,
      hasKey: Boolean(getSetting('domain_license_key', '')),
      licenseInfo,
      layout: false
    });
  };
}

module.exports = {
  normalizeDomain, licenseDomainForHost, verifyLicense, checkRequestLicense,
  requireDomainLicense, getBackgroundLicenseState, isBackgroundAllowed,
  getInstallCode: () => instanceIdentity.getInstallCode(),
  LOCAL_DOMAIN, licenseInfo
};
