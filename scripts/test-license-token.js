/**
 * Uji verifikasi token lisensi Ed25519 (v3) tanpa jaringan.
 * Pakai: node scripts/test-license-token.js <path-jwk-privat> [installCode]
 * Kunci privat TIDAK ada di repo; default membaca C:/ZenRadius/license-keys/ed25519-signing.jwk.json
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const jwkPath = process.argv[2] || 'C:/ZenRadius/license-keys/ed25519-signing.jwk.json';
const jwk = JSON.parse(fs.readFileSync(jwkPath, 'utf8'));
const priv = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(payload) {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign(null, Buffer.from(body), priv);
  return `ZRL1.${body}.${b64u(sig)}`;
}

const tokenSvc = require(path.join(__dirname, '..', 'services', 'licenseTokenService'));
const anchor = require(path.join(__dirname, '..', 'config', 'licenseTrustAnchor'));
if (anchor.PUBLIC_KEYS[anchor.DEFAULT_KID] !== jwk.x) {
  console.error('FAIL: kunci publik di licenseTrustAnchor tidak cocok dengan JWK privat'); process.exit(1);
}

const ic = (process.argv[3] || 'ABCD-1234-EF56').toUpperCase();
const now = Math.floor(Date.now() / 1000);
let fails = 0;
const check = (name, r, expectValid, expectReason) => {
  const ok = r.valid === expectValid && (expectValid || r.reason === expectReason);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → valid=${r.valid} reason=${r.reason}`);
  if (!ok) fails++;
};

const good = sign({ v: 1, kid: 'k1', lid: 'L-TEST', sub: 'example.com', ic, iat: now, exp: null, plan: 'lifetime' });
check('token sah (domain)', tokenSvc.verifyToken(good, { subject: 'example.com', installCode: ic }), true);
check('token sah (local)', tokenSvc.verifyToken(sign({ v: 1, kid: 'k1', lid: 'L-2', sub: 'local', ic, iat: now, exp: null }), { subject: 'local', installCode: ic }), true);
check('subject beda', tokenSvc.verifyToken(good, { subject: 'other.com', installCode: ic }), false, 'subject_mismatch');
check('install code beda', tokenSvc.verifyToken(good, { subject: 'example.com', installCode: 'ZZZZ-ZZZZ-ZZZZ' }), false, 'install_mismatch');
check('expired', tokenSvc.verifyToken(sign({ v: 1, kid: 'k1', lid: 'L-3', sub: 'example.com', ic, iat: now - 100, exp: now - 10 }), { subject: 'example.com', installCode: ic }), false, 'expired');
check('kid tidak dikenal', tokenSvc.verifyToken(sign({ v: 1, kid: 'k9', lid: 'L-4', sub: 'example.com', ic, iat: now }), { subject: 'example.com', installCode: ic }), false, 'unknown_kid');
// Tamper payload
const parts = good.split('.');
const tampered = `${parts[0]}.${b64u(Buffer.from(JSON.stringify({ v: 1, kid: 'k1', lid: 'L-TEST', sub: 'evil.com', ic, iat: now, exp: null })))}.${parts[2]}`;
check('payload dimanipulasi', tokenSvc.verifyToken(tampered, { subject: 'evil.com', installCode: ic }), false, 'signature');
// Signed with other key
const other = crypto.generateKeyPairSync('ed25519').privateKey;
const forged = (() => { const body = parts[1]; const sig = crypto.sign(null, Buffer.from(body), other); return `ZRL1.${body}.${b64u(sig)}`; })();
check('kunci palsu', tokenSvc.verifyToken(forged, { subject: 'example.com', installCode: ic }), false, 'signature');
check('format salah', tokenSvc.verifyToken('ABCD-1234', { subject: 'example.com', installCode: ic }), false, 'format');

console.log(fails ? `\n${fails} test gagal` : '\nSemua test lulus');
console.log('\nContoh token:', good);
process.exit(fails ? 1 : 0);
