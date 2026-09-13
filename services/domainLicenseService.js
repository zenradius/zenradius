/**
 * Domain License Service
 * Verifikasi lisensi seumur hidup berbasis domain (HMAC-SHA256).
 * Kunci dihasilkan oleh generator di https://licensi.zenradius.net
 * dengan Master Secret yang sama dengan ZENRADIUS_LICENSE_SECRET.
 */
const crypto = require('crypto');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

// Secret master yang di-hardcode langsung demi kepraktisan & keamanan internal
const MASTER_SECRET = '@Du4du4220215@';

let cache = { key: null, host: null, valid: false, at: 0 };
const CACHE_MS = 5000;

function normalizeDomain(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .split('/')[0]
    .split(':')[0];
}

function computeSignature(domain) {
  return crypto.createHmac('sha256', MASTER_SECRET).update(domain).digest('hex');
}

function verifyLicense(domain, licenseKey) {
  if (!MASTER_SECRET) return { valid: false, reason: 'secret_missing' };
  const clean = normalizeDomain(domain);
  const key = String(licenseKey || '').trim().toLowerCase();
  if (!clean || !/^[0-9a-f]{64}$/.test(key)) return { valid: false, reason: 'format' };

  const expected = computeSignature(clean);
  const ok = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(key, 'hex'));
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
    return { valid: cache.valid, host };
  }

  // Localhost/dev selalu diizinkan
  if (isLocalHost(host)) {
    cache = { key: licenseKey, host, valid: true, at: now };
    return { valid: true, host, dev: true };
  }

  const result = verifyLicense(host, licenseKey);
  cache = { key: licenseKey, host, valid: result.valid, at: now };
  if (!result.valid) {
    logger.warn(`[license] Lisensi tidak valid untuk domain "${host}" (${result.reason})`);
  }
  return { ...result, host };
}

/**
 * Middleware: blokir akses jika lisensi tidak valid.
 * Route settings & login tetap diizinkan agar admin bisa memasukkan lisensi.
 */
function requireDomainLicense(options = {}) {
  const allowPaths = options.allowPaths || [
    '/admin/login', '/admin/logout', '/admin/settings', '/api/settings',
    '/license', '/css', '/js', '/img', '/manifest', '/sw.js', '/favicon'
  ];

  return (req, res, next) => {
    if (allowPaths.some(p => req.path.startsWith(p))) return next();

    const result = checkRequestLicense(req);
    res.locals.licenseValid = result.valid;
    if (result.valid) return next();

    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(402).json({ error: 'Lisensi domain tidak valid', domain: result.host });
    }
    return res.status(402).render('license-required', {
      domain: result.host,
      hasKey: Boolean(getSetting('domain_license_key', '')),
      layout: false
    });
  };
}

module.exports = { normalizeDomain, verifyLicense, checkRequestLicense, requireDomainLicense };
