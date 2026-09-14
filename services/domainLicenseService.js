/**
 * Domain License Service
 * Verifikasi lisensi seumur hidup berbasis domain (HMAC-SHA256).
 * Kunci dihasilkan oleh generator di https://licensi.zenradius.net
 * dengan Master Secret yang sama dengan ZENRADIUS_LICENSE_SECRET.
 */
const crypto = require('crypto');
const { getSetting, saveSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const licenseInfo = require('../config/licenseInfo');

// Secret master yang di-hardcode langsung demi kepraktisan & keamanan internal
const MASTER_SECRET = '@Du4du4220215@';

let cache = { key: null, host: null, valid: false, at: 0 };
const CACHE_MS = 5000;
const GRACE_MS = licenseInfo.LICENSE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Masa tenggang: saat lisensi pertama kali terdeteksi tidak valid pada sebuah host,
 * catat waktunya. Selama GRACE_DAYS akses tetap diizinkan dengan banner peringatan.
 */
function getGraceState(host) {
  const startedAt = Number(getSetting('license_grace_started_at', 0)) || 0;
  const graceHost = String(getSetting('license_grace_host', '') || '');
  const now = Date.now();
  if (!startedAt || graceHost !== host) {
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
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .split('/')[0]
    .split(':')[0];
}

function computeSignature(domain) {
  // Gunting HMAC menjadi 16 karakter Hex pendek, lalu bentuk format XXXX-XXXX-XXXX-XXXX huruf besar
  const hash = crypto.createHmac('sha256', MASTER_SECRET).update(domain).digest('hex').toUpperCase();
  const rawKey = hash.substring(0, 16);
  return `${rawKey.substring(0,4)}-${rawKey.substring(4,8)}-${rawKey.substring(8,12)}-${rawKey.substring(12,16)}`;
}

function verifyLicense(domain, licenseKey) {
  if (!MASTER_SECRET) return { valid: false, reason: 'secret_missing' };
  const clean = normalizeDomain(domain);
  const key = String(licenseKey || '').trim().toUpperCase();
  if (!clean || !/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) return { valid: false, reason: 'format' };

  const expected = computeSignature(clean);
  const ok = (expected === key); // String direct comparison aman karena format sudah tervalidasi rigid
  return { valid: ok, reason: ok ? null : 'mismatch', domain: clean };
}

function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host);
}

/**
 * Cek lisensi untuk request saat ini (berdasarkan Host header).
 */
function checkRequestLicense(req) {
  const host = normalizeDomain(req.hostname || req.headers.host);
  const licenseKey = getSetting('domain_license_key', '');
  const now = Date.now();

  if (cache.key === licenseKey && cache.host === host && now - cache.at < CACHE_MS) {
    return { valid: cache.valid, host, grace: cache.grace || null };
  }

  // Localhost/dev selalu diizinkan
  if (isLocalHost(host)) {
    cache = { key: licenseKey, host, valid: true, at: now, grace: null };
    return { valid: true, host, dev: true };
  }

  const result = verifyLicense(host, licenseKey);
  let grace = null;
  if (result.valid) {
    clearGrace();
  } else {
    grace = getGraceState(host);
    logger.warn(`[license] Lisensi tidak valid untuk domain "${host}" (${result.reason}); masa tenggang ${grace.inGrace ? grace.daysLeft + ' hari tersisa' : 'berakhir'}`);
  }
  cache = { key: licenseKey, host, valid: result.valid, at: now, grace };
  return { ...result, host, grace };
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
    res.locals.licenseGrace = (!result.valid && result.grace && result.grace.inGrace) ? result.grace : null;

    if (isAllowed || result.valid) return next();
    if (res.locals.licenseGrace) return next();

    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(402).json({ error: 'Lisensi domain tidak valid', domain: result.host });
    }
    return res.status(402).render('license-required', {
      domain: result.host,
      hasKey: Boolean(getSetting('domain_license_key', '')),
      licenseInfo,
      layout: false
    });
  };
}

module.exports = { normalizeDomain, verifyLicense, checkRequestLicense, requireDomainLicense, licenseInfo };
