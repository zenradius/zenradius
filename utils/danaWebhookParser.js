/**
 * DANA Bisnis Webhook Payment Parser
 * Parses DANA transaction notifications and extracts payment details
 */

/**
 * Parse DANA webhook payload
 * DANA sends payment notifications in this format:
 * {
 *   "transactionId": "TXN-20260921-12345",
 *   "amount": 50000,
 *   "currency": "IDR",
 *   "status": "SUCCESS",
 *   "timestamp": "2026-09-21T20:50:00+07:00",
 *   "reference": "INV-12345 or VOUCHER-12345",
 *   "description": "Payment QRIS"
 * }
 */
function parseDanaPayload(body) {
  if (!body) throw new Error('DANA payload kosong');

  const payload = typeof body === 'string' ? JSON.parse(body) : body;

  const status = String(payload?.status || '').toUpperCase();
  if (status !== 'SUCCESS' && status !== 'COMPLETED') {
    return null; // Payment not successful
  }

  const amount = Number(payload?.amount || 0);
  if (!amount || amount <= 0) {
    throw new Error('DANA amount tidak valid');
  }

  const txnId = String(payload?.transactionId || '').trim();
  if (!txnId) {
    throw new Error('DANA transactionId kosong');
  }

  return {
    service: 'dana',
    amount,
    txnId,
    reference: String(payload?.reference || '').trim(),
    description: String(payload?.description || '').trim(),
    timestamp: String(payload?.timestamp || '').trim(),
    rawPayload: payload
  };
}

/**
 * Verify DANA webhook signature (if DANA provides one)
 * Some payment gateways include X-Signature header
 */
function verifyDanaSignature(payload, signature, secret) {
  if (!signature || !secret) return true; // Skip if not configured

  // DANA typically uses HMAC-SHA256
  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');

  return signature === expected;
}

/**
 * Extract amount from DANA reference/description for matching
 * (in case QRIS unique code is in transaction reference)
 */
function extractQrisUniqueCodeFromDana(payload) {
  // Look for pattern: QRIS-NNN or code in reference/description
  const text = `${payload.reference} ${payload.description}`;
  const match = text.match(/QRIS[^0-9]*(\d{1,3})/i) || text.match(/(\d{1,3})/);
  return match ? Number(match[1]) : null;
}

module.exports = {
  parseDanaPayload,
  verifyDanaSignature,
  extractQrisUniqueCodeFromDana
};
