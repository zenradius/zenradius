/**
 * Voucher Fulfillment Service
 *
 * Single source of truth for turning a paid `public_voucher_orders` row into
 * an actual MikroTik hotspot user + WhatsApp delivery.
 *
 * Previously this logic was duplicated in:
 *  - app-customer.js (fulfillVoucherOrder, used by /api/webhook/v1/payment-notif)
 *  - routes/customerPortal.js (inline block inside POST /payment/callback)
 * Both call sites now delegate here to avoid drift between the two flows.
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const mikrotikService = require('./mikrotikService');

const selectVoucherOrderById = db.prepare(`SELECT * FROM public_voucher_orders WHERE id = ?`);

const markVoucherFulfilled = db.prepare(`
  UPDATE public_voucher_orders
  SET status='fulfilled',
      fulfilled_at=CURRENT_TIMESTAMP,
      voucher_code=?,
      voucher_password=?,
      voucher_comment=?,
      updated_at=CURRENT_TIMESTAMP
  WHERE id=?
`);

const markVoucherWaSentOk = db.prepare(`
  UPDATE public_voucher_orders
  SET wa_sent=1, wa_sent_at=CURRENT_TIMESTAMP, wa_error='', updated_at=CURRENT_TIMESTAMP
  WHERE id=?
`);

const markVoucherWaSentErr = db.prepare(`
  UPDATE public_voucher_orders
  SET wa_sent=0, wa_error=?, updated_at=CURRENT_TIMESTAMP
  WHERE id=?
`);

/** Generate a voucher code using the same alphabet rules as admin-created batches. */
function genCustomCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

/** Resolve prefix/codeLength/charset from voucher_packages, falling back to defaults. */
function resolveCodeFormat(routerId, profileName) {
  let prefix = '';
  let codeLength = 6;
  let charset = 'mixed';
  try {
    const pkg = db.prepare('SELECT * FROM voucher_packages WHERE router_id IS ? AND profile_name = ?').get(routerId ?? null, profileName);
    if (pkg) {
      prefix = String(pkg.prefix || '').trim();
      codeLength = Math.max(4, Math.min(16, Number(pkg.code_length) || 6));
      charset = String(pkg.charset || 'mixed');
    }
  } catch (e) {
    logger.error('[VoucherFulfillment] Gagal query voucher_packages: ' + e.message);
  }
  return { prefix, codeLength, charset };
}

/** Create the MikroTik hotspot user, retrying on code collisions. */
async function createHotspotVoucherUser(order) {
  const { prefix, codeLength, charset } = resolveCodeFormat(order.router_id, order.profile_name);

  let created = null;
  let attempt = 0;
  while (attempt < 10) {
    attempt++;
    const coreLen = Math.max(4, codeLength - prefix.length);
    const code = prefix + genCustomCode(coreLen, charset);
    const pass = code;
    const comment = `vc-${code}-${order.profile_name}`;
    const userData = {
      server: 'all',
      name: code,
      password: pass,
      profile: order.profile_name,
      comment
    };
    if (order.validity) userData['limit-uptime'] = order.validity;

    try {
      await mikrotikService.addHotspotUser(userData, order.router_id ?? null);
      created = { code, pass, comment };
      break;
    } catch (e) {
      const msg = String(e?.message || e || '').toLowerCase();
      const isDup = msg.includes('already') || msg.includes('exist') || msg.includes('duplicate');
      if (isDup) {
        logger.warn(`[VoucherFulfillment] Kode duplikat (attempt ${attempt}/10) untuk order=${order.id}, mencoba ulang...`);
        continue;
      }
      throw e;
    }
  }
  if (!created) throw new Error('Gagal membuat voucher (kode duplikat terlalu sering)');
  return created;
}

/** Build the WA delivery message shown to buyers upon fulfillment. */
function buildVoucherDeliveryMessage(order, created, methodLabel) {
  return (
    `🎫 *VOUCHER HOTSPOT*\n\n` +
    `✅ Pembayaran diterima via *${methodLabel || 'QRIS'}*\n` +
    `📦 Paket: *${order.profile_name}* (${order.validity || '-'})\n` +
    `💰 Harga: Rp ${Number(order.price || 0).toLocaleString('id-ID')}\n\n` +
    `👤 User: *${created.code}*\n` +
    `🔑 Pass: *${created.pass}*\n\n` +
    `Terima kasih.`
  );
}

/** Send the fulfillment WA message and record success/failure on the order row. */
async function sendVoucherDeliveryWa(order, created, methodLabel) {
  try {
    const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') throw new Error('Bot WhatsApp belum terhubung');
    if (!order.buyer_phone) throw new Error('Nomor WhatsApp pembeli kosong');
    const msg = buildVoucherDeliveryMessage(order, created, methodLabel);
    await sendWA(order.buyer_phone, msg);
    markVoucherWaSentOk.run(order.id);
    return { ok: true };
  } catch (waErr) {
    const errMsg = String(waErr?.message || waErr || '');
    markVoucherWaSentErr.run(errMsg, order.id);
    logger.error(`[VoucherFulfillment] WA notif gagal (order=${order.id}): ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}

/**
 * Fulfill a paid voucher order: create the MikroTik hotspot user, persist the
 * result, and notify the buyer via WhatsApp. Idempotent — safe to call
 * multiple times for the same order (webhooks can retry/duplicate).
 *
 * @param {number} orderId
 * @param {object} [opts]
 * @param {string} [opts.methodLabel] Label shown in the WA message (e.g. "QRIS (Tripay)")
 * @returns {Promise<{ok: boolean, already?: boolean, created?: object, reason?: string}>}
 */
async function fulfillVoucherOrder(orderId, opts = {}) {
  const order = selectVoucherOrderById.get(orderId);
  if (!order) throw new Error('Order tidak ditemukan');
  if (String(order.status) === 'fulfilled' && order.voucher_code) return { ok: true, already: true };
  if (String(order.status) !== 'paid') return { ok: false, reason: 'not_paid' };

  const created = await createHotspotVoucherUser(order);
  markVoucherFulfilled.run(created.code, created.pass, created.comment, orderId);

  const methodLabel = opts.methodLabel || 'QRIS Statis';
  const waResult = await sendVoucherDeliveryWa(order, created, methodLabel);

  return { ok: true, created, wa: waResult };
}

module.exports = {
  fulfillVoucherOrder,
  createHotspotVoucherUser,
  resolveCodeFormat,
  genCustomCode,
  buildVoucherDeliveryMessage
};
