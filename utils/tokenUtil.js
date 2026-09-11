/**
 * Token utility untuk public payment tokens
 * Digunakan untuk polling status pembayaran tanpa memerlukan session login
 */
const crypto = require('crypto');

/**
 * Phase 12: fail-closed secret resolver.
 * Fallback secret statis membuat token publik dapat dipalsukan oleh siapa pun
 * yang membaca source code. Bila secret tidak tersedia, penandatanganan dan
 * verifikasi harus GAGAL, bukan memakai nilai yang dapat ditebak.
 */
function resolveSecret(secret) {
  const s = String(secret || '').trim();
  return s.length >= 8 ? s : null;
}

/**
 * Sign public token untuk payment (HMAC-SHA256)
 * @param {Object} payload - Data: {invoiceId, customerId, lookup, exp}
 * @param {string} secret - Session secret
 * @returns {string} Base64-encoded token
 */
function signPublicToken(payload, secret) {
  try {
    const key = resolveSecret(secret);
    if (!key) {
      console.error('[signPublicToken] Secret tidak dikonfigurasi — token tidak dibuat');
      return '';
    }
    const json = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', key)
      .update(json)
      .digest('hex');
    
    const tokenData = {
      data: json,
      sig: signature
    };
    
    return Buffer.from(JSON.stringify(tokenData)).toString('base64');
  } catch (e) {
    console.error('[signPublicToken] Error:', e.message);
    return '';
  }
}

/**
 * Verify public token
 * @param {string} token - Base64-encoded token
 * @param {string} secret - Session secret
 * @returns {Object|null} Payload if valid, null if invalid/expired
 */
function verifyPublicToken(token, secret) {
  try {
    const key = resolveSecret(secret);
    if (!key) return null;
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const tokenData = JSON.parse(decoded);
    
    const { data, sig } = tokenData;
    const expectedSig = crypto
      .createHmac('sha256', key)
      .update(data)
      .digest('hex');
    
    if (typeof sig !== 'string' || sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return null;
    }
    
    const payload = JSON.parse(data);
    
    // Check expiry
    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }
    
    return payload;
  } catch (e) {
    console.error('[verifyPublicToken] Error:', e.message);
    return null;
  }
}

module.exports = {
  signPublicToken,
  verifyPublicToken
};
