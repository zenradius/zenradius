/**
 * License Token Service — verifikasi token lisensi bertanda tangan Ed25519 (v3).
 *
 * Token: ZRL1.<base64url(payload)>.<base64url(sig)>
 * Hanya kunci publik yang ada di aplikasi (config/licenseTrustAnchor.js), sehingga
 * pengguna tidak dapat menerbitkan token sendiri meski memiliki seluruh source code.
 */
const crypto = require('crypto');
const anchor = require('../config/licenseTrustAnchor');

const INSTALL_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function b64uToBuf(s) {
  const str = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(str + '='.repeat((4 - (str.length % 4)) % 4), 'base64');
}

function publicKeyFor(kid) {
  const x = anchor.PUBLIC_KEYS[kid || anchor.DEFAULT_KID];
  if (!x) return null;
  try {
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  } catch (_) { return null; }
}

function isToken(value) {
  return String(value || '').trim().startsWith(anchor.TOKEN_PREFIX + '.');
}

/**
 * Parse + verifikasi tanda tangan & struktur payload. Tidak memeriksa subjek/instalasi.
 * @returns {{ok:boolean, reason?:string, payload?:object}}
 */
function parseToken(raw) {
  const token = String(raw || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== anchor.TOKEN_PREFIX) return { ok: false, reason: 'format' };
  let payload;
  try { payload = JSON.parse(b64uToBuf(parts[1]).toString('utf8')); } catch (_) { return { ok: false, reason: 'payload' }; }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload' };

  const key = publicKeyFor(payload.kid);
  if (!key) return { ok: false, reason: 'unknown_kid' };
  const sig = b64uToBuf(parts[2]);
  if (sig.length !== 64) return { ok: false, reason: 'signature' };
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(parts[1], 'utf8'), key, sig); } catch (_) { valid = false; }
  if (!valid) return { ok: false, reason: 'signature' };

  if (payload.v !== 1) return { ok: false, reason: 'version' };
  if (typeof payload.lid !== 'string' || !payload.lid) return { ok: false, reason: 'payload' };
  if (typeof payload.sub !== 'string' || !payload.sub) return { ok: false, reason: 'payload' };
  if (typeof payload.ic !== 'string' || !INSTALL_RE.test(payload.ic)) return { ok: false, reason: 'payload' };
  if (!Number.isFinite(payload.iat)) return { ok: false, reason: 'payload' };
  if (payload.exp != null && !Number.isFinite(payload.exp)) return { ok: false, reason: 'payload' };
  return { ok: true, payload };
}

/**
 * Verifikasi penuh terhadap instalasi ini.
 * @param {string} raw token
 * @param {{subject:string, installCode:string, now?:number}} ctx
 */
function verifyToken(raw, ctx) {
  const parsed = parseToken(raw);
  if (!parsed.ok) return { valid: false, reason: parsed.reason };
  const p = parsed.payload;
  const now = Math.floor((ctx.now || Date.now()) / 1000);
  if (p.ic !== String(ctx.installCode || '').toUpperCase()) return { valid: false, reason: 'install_mismatch', payload: p };
  if (p.sub !== String(ctx.subject || '').toLowerCase()) return { valid: false, reason: 'subject_mismatch', payload: p };
  if (p.iat > now + 86400) return { valid: false, reason: 'not_yet_valid', payload: p };
  if (p.exp != null && p.exp <= now) return { valid: false, reason: 'expired', payload: p };
  return { valid: true, reason: null, payload: p };
}

module.exports = { isToken, parseToken, verifyToken, INSTALL_RE };
