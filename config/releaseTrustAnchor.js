/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Release Trust Anchor (ISP-instance side) — Phase 10B
 * ─────────────────────────────────────────────────────────────────────────────
 *  SEPARATE trust domain from license signing (config/licenseTrustAnchor.js).
 *  ISP instance HANYA memiliki PUBLIC verification key untuk release.
 *
 *  TIDAK BOLEH ADA PRIVATE KEY DI FILE INI ATAU DI REPOSITORY ISP.
 *  Private release signing key hanya berada pada vendor release infrastructure,
 *  TIDAK PERNAH sama dengan private license signing key.
 *
 *  Trust anchor resolution order (immutable untuk operasi normal):
 *    1. process.env.RELEASE_PUBLIC_KEY / RELEASE_PUBLIC_KEY_FILE (PEM/base64)
 *    2. BUNDLED_RELEASE_PUBLIC_KEY_PEM (konstanta build-time, diisi vendor)
 *
 *  Jika belum tersedia → verifikasi FAIL-CLOSED (CONFIGURATION REQUIRED).
 *  Jangan mengarang key produksi, jangan reuse license key.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const crypto = require('crypto');

// Diisi oleh vendor pada saat build/rilis distribusi. Kosong = fail-closed.
const BUNDLED_RELEASE_PUBLIC_KEY_PEM = '';

let testOverridePem = null;

function __setTestPublicKey(pem) {
  if (process.env.NODE_ENV === 'production') return false;
  testOverridePem = pem ? String(pem) : null;
  return true;
}

function getRawPublicKeyMaterial() {
  if (testOverridePem) return testOverridePem;
  const file = String(process.env.RELEASE_PUBLIC_KEY_FILE || '').trim();
  if (file) {
    try { return fs.readFileSync(file, 'utf8'); } catch { /* fall through */ }
  }
  const fromEnv = String(process.env.RELEASE_PUBLIC_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const bundled = String(BUNDLED_RELEASE_PUBLIC_KEY_PEM || '').trim();
  return bundled || null;
}

/** @returns {crypto.KeyObject|null} */
function getPublicKey() {
  const raw = getRawPublicKeyMaterial();
  if (!raw) return null;
  try {
    if (raw.includes('BEGIN PUBLIC KEY')) {
      return crypto.createPublicKey({ key: raw, format: 'pem', type: 'spki' });
    }
    // base64 raw 32-byte Ed25519 public key → bungkus ke DER SPKI (sama pola license trust anchor).
    const rawBytes = Buffer.from(raw, 'base64');
    if (rawBytes.length !== 32) return null;
    const prefix = Buffer.from('302a300506032b6570032100', 'hex');
    const der = Buffer.concat([prefix, rawBytes]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

function isTrustAnchorConfigured() {
  return getPublicKey() !== null;
}

module.exports = {
  getPublicKey,
  isTrustAnchorConfigured,
  __setTestPublicKey
};
