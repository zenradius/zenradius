const fs = require('fs');
const crypto = require('crypto');

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
    try { return fs.readFileSync(file, 'utf8'); } catch {  }
  }
  const fromEnv = String(process.env.RELEASE_PUBLIC_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const bundled = String(BUNDLED_RELEASE_PUBLIC_KEY_PEM || '').trim();
  return bundled || null;
}

function getPublicKey() {
  const raw = getRawPublicKeyMaterial();
  if (!raw) return null;
  try {
    if (raw.includes('BEGIN PUBLIC KEY')) {
      return crypto.createPublicKey({ key: raw, format: 'pem', type: 'spki' });
    }
    
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
