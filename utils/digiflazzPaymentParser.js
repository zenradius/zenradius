/**
 * Digiflazz Payment Gateway Parser & Webhook Handler
 * Parses Digiflazz payment notifications for customer-facing payments (not PPOB)
 * 
 * Digiflazz payment gateway webhook format:
 * POST /webhook/digiflazz with:
 * {
 *   "ref_id": "external_id_from_your_system",
 *   "status": "success" | "pending" | "failed",
 *   "amount": 50000,
 *   "method": "transfer_bank" | "qris" | "e_money",
 *   "timestamp": "2026-09-21T20:50:00+07:00",
 *   "signature": "...",
 *   "trx_id": "DF-12345678"
 * }
 */

const crypto = require('crypto');

/**
 * Parse Digiflazz payment webhook payload
 */
function parseDigiflazzPayload(body) {
  if (!body) throw new Error('Digiflazz payload kosong');

  const payload = typeof body === 'string' ? JSON.parse(body) : body;

  const status = String(payload?.status || '').toLowerCase();
  if (!['success', 'completed'].includes(status)) {
    return null; // Payment not successful
  }

  const amount = Number(payload?.amount || 0);
  if (!amount || amount <= 0) {
    throw new Error('Digiflazz amount tidak valid');
  }

  const refId = String(payload?.ref_id || '').trim();
  if (!refId) {
    throw new Error('Digiflazz ref_id kosong');
  }

  return {
    service: 'digiflazz_payment',
    amount,
    refId,
    trxId: String(payload?.trx_id || '').trim(),
    method: String(payload?.method || 'transfer_bank').trim(),
    timestamp: String(payload?.timestamp || '').trim(),
    description: String(payload?.description || '').trim(),
    rawPayload: payload
  };
}

/**
 * Verify Digiflazz webhook signature using HMAC-SHA256
 * Digiflazz signs with: HMAC-SHA256(JSON.stringify(body), secret)
 */
function verifyDigiflazzSignature(payload, signature, secret) {
  if (!signature || !secret) return true; // Skip if not configured

  try {
    const jsonStr = typeof payload === 'string' 
      ? payload 
      : JSON.stringify(payload);
    
    const expected = crypto
      .createHmac('sha256', secret)
      .update(jsonStr)
      .digest('hex');

    return signature === expected;
  } catch (e) {
    return false;
  }
}

/**
 * Extract amount from Digiflazz ref_id if it's stored as part of the reference
 * Digiflazz might allow custom ref_id that contains amount info
 */
function extractQrisUniqueCodeFromDigiflazz(payload) {
  // If ref_id has format like "INV-12345" or "VOUCHER-12345", extract from it
  const refId = String(payload?.ref_id || '');
  // Look for numeric code at end
  const match = refId.match(/(\d{1,3})$/) || refId.match(/(\d{1,3})/);
  return match ? Number(match[1]) : null;
}

/**
 * Normalize phone number from Digiflazz payload if provided
 */
function normalizePhoneFromDigiflazz(payload) {
  const phone = String(payload?.phone || payload?.customer_phone || '').trim();
  if (!phone) return null;
  
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.substring(1);
  if (p.startsWith('62')) return p;
  return p;
}

module.exports = {
  parseDigiflazzPayload,
  verifyDigiflazzSignature,
  extractQrisUniqueCodeFromDigiflazz,
  normalizePhoneFromDigiflazz
};
