/** Token utility untuk public payment tokens */
const crypto = require('crypto');

/** Fallback secret statis membuat token publik dapat dipalsukan oleh siapa pun */
function resolveSecret(secret) {
  const s = String(secret || '').trim();
  return s.length >= 8 ? s : null;
}

/** Sign public token untuk payment (HMAC-SHA256) */
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

/** Verify public token */
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
