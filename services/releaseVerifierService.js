/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Release Verifier Service — Phase 10B
 * ─────────────────────────────────────────────────────────────────────────────
 *  Verifikasi metadata & artifact release resmi. SEPARATE trust domain dari
 *  license (services/licenseVerifierService.js). Tidak reuse license key.
 *
 *  Release metadata (JSON) minimal:
 *    { schema, version, artifact, artifact_size, sha256, signature, published_at, channel }
 *
 *  Signature dihitung atas canonical JSON dari field selain `signature`
 *  (deterministic key order), base64 Ed25519 signature.
 *
 *  Fail-closed: apa pun yang tidak dapat diverifikasi → BUKAN VALID.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const crypto = require('crypto');
const trustAnchor = require('../config/releaseTrustAnchor');

const STATUS = Object.freeze({
  VALID: 'VALID',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  UNCONFIGURED: 'UNCONFIGURED',
  DOWNGRADE_REJECTED: 'DOWNGRADE_REJECTED',
  SAME_VERSION: 'SAME_VERSION',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  SIZE_MISMATCH: 'SIZE_MISMATCH'
});

const METADATA_FIELDS = ['schema', 'version', 'artifact', 'artifact_size', 'sha256', 'published_at', 'channel'];
const SEMVER_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
const ALLOWED_CHANNELS = new Set(['stable', 'beta']);

function fail(status, extra = {}) {
  return { valid: false, status, ...extra };
}

/**
 * Parse semver "x.y.z". @returns {[number,number,number]|null}
 */
function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Safe comparison. @returns -1 | 0 | 1 | null (null = invalid input)
 */
function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function canonicalizeMetadata(meta) {
  const out = {};
  for (const field of METADATA_FIELDS) {
    let v = meta[field];
    if (field === 'schema' || field === 'artifact_size') v = Number(v);
    else v = v === null || v === undefined ? '' : String(v);
    out[field] = v;
  }
  return JSON.stringify(out);
}

/**
 * Validate metadata SHAPE only (does not touch network/filesystem).
 */
function validateMetadataShape(meta) {
  if (!meta || typeof meta !== 'object') return fail(STATUS.INVALID_FORMAT, { message: 'Metadata tidak valid.' });
  if (Number(meta.schema) !== 1) return fail(STATUS.INVALID_FORMAT, { message: 'Schema metadata tidak dikenali.' });
  if (!parseSemver(meta.version)) return fail(STATUS.INVALID_FORMAT, { message: 'Format versi tidak valid.' });
  if (!ARTIFACT_NAME_RE.test(String(meta.artifact || ''))) return fail(STATUS.INVALID_FORMAT, { message: 'Nama artifact tidak valid.' });
  const size = Number(meta.artifact_size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 * 1024 * 1024) {
    return fail(STATUS.INVALID_FORMAT, { message: 'Ukuran artifact tidak valid.' });
  }
  if (!SHA256_HEX_RE.test(String(meta.sha256 || ''))) return fail(STATUS.INVALID_FORMAT, { message: 'Format checksum tidak valid.' });
  if (!meta.signature || typeof meta.signature !== 'string') return fail(STATUS.INVALID_FORMAT, { message: 'Signature tidak ada.' });
  if (!Number.isFinite(Date.parse(String(meta.published_at || '')))) return fail(STATUS.INVALID_FORMAT, { message: 'Tanggal rilis tidak valid.' });
  if (!ALLOWED_CHANNELS.has(String(meta.channel || ''))) return fail(STATUS.INVALID_FORMAT, { message: 'Channel rilis tidak dikenali.' });
  return { valid: true, status: STATUS.VALID };
}

/**
 * Verify release metadata signature (Ed25519) against the trusted release
 * public key. Fail-closed jika trust anchor belum dikonfigurasi.
 */
function verifyMetadataSignature(meta) {
  const shape = validateMetadataShape(meta);
  if (!shape.valid) return shape;

  const publicKey = trustAnchor.getPublicKey();
  if (!publicKey) return fail(STATUS.UNCONFIGURED, { message: 'Release public key belum dikonfigurasi.' });

  let signatureOk = false;
  try {
    const sig = Buffer.from(String(meta.signature), 'base64');
    const input = Buffer.from(canonicalizeMetadata(meta), 'utf8');
    signatureOk = sig.length === 64 && crypto.verify(null, input, publicKey, sig);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return fail(STATUS.INVALID_SIGNATURE, { message: 'Signature release tidak valid.' });

  return { valid: true, status: STATUS.VALID, message: 'Metadata release valid.' };
}

/**
 * Version policy: newer-only by default. Tidak mengizinkan downgrade arbitrary.
 */
function evaluateVersionPolicy(currentVersion, candidateVersion, { allowSame = true } = {}) {
  const cmp = compareVersions(currentVersion, candidateVersion);
  if (cmp === null) return fail(STATUS.INVALID_FORMAT, { message: 'Versi tidak dapat dibandingkan.' });
  if (cmp === 0) {
    return allowSame
      ? { valid: true, status: STATUS.SAME_VERSION, message: 'Versi sudah terbaru.' }
      : fail(STATUS.SAME_VERSION, { message: 'Versi sudah terbaru.' });
  }
  if (cmp > 0) return fail(STATUS.DOWNGRADE_REJECTED, { message: 'Downgrade tidak diizinkan melalui jalur update biasa.' });
  return { valid: true, status: STATUS.VALID, message: 'Versi baru tersedia.' };
}

/**
 * Verify a downloaded artifact buffer/stream digest against metadata.
 * Caller computes actualSize/actualSha256 while streaming to disk (Phase 10B
 * download layer) — this function only compares, never reads the file itself,
 * so the same module can be used with any Buffer or precomputed digest.
 */
function verifyArtifactDigest(meta, { actualSize, actualSha256 }) {
  const shape = validateMetadataShape(meta);
  if (!shape.valid) return shape;
  if (Number(actualSize) !== Number(meta.artifact_size)) {
    return fail(STATUS.SIZE_MISMATCH, { message: 'Ukuran artifact tidak sesuai metadata.' });
  }
  const expected = String(meta.sha256 || '').toLowerCase();
  const actual = String(actualSha256 || '').toLowerCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return fail(STATUS.CHECKSUM_MISMATCH, { message: 'Checksum artifact tidak cocok.' });
  return { valid: true, status: STATUS.VALID, message: 'Artifact terverifikasi.' };
}

module.exports = {
  STATUS,
  parseSemver,
  compareVersions,
  validateMetadataShape,
  verifyMetadataSignature,
  evaluateVersionPolicy,
  verifyArtifactDigest
};
