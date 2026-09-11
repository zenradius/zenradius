const { logger } = require('../config/logger');
const db = require('../config/database');
const metaService = require('./metaWhatsappService');

function normalizePhone(phone) {
  return metaService.normalizePhone(phone);
}

/**
 * Webhook inbound universal — Fonnte, Wablas, Starsender, Woowa, GOWA, dll.
 * Provider cukup arahkan webhook ke salah satu URL di bawah (POST JSON):
 *   POST /api/webhook/wa-inbound          (universal)
 *   POST /api/webhook/fonnte              (alias Fonnte)
 *   POST /api/webhook/wablas              (alias Wablas)
 *   GET  /api/webhook/wa-inbound?sender=62xxx&message=halo&token=xxx  (GET fallback)
 */
async function handleInbound(req, res) {
  try {
    const body = req.body || {};
    const query = req.query || {};

    // Coba ekstrak nomor pengirim & pesan dari berbagai format provider
    let senderPhone =
      body.sender || body.from || body.phone || body.fromPhone || body.number ||
      body.senderNumber || body.wa_number || body.source || body.chatId ||
      body.data?.sender || body.data?.from || body.data?.phone ||
      body.message?.from || body.result?.sender ||
      query.sender || query.from || query.phone || query.number || '';

    let messageText =
      body.message || body.text || body.body || body.caption || body.content ||
      body.data?.message || body.data?.text || body.data?.body ||
      body.message?.text || body.message?.body || body.result?.message ||
      query.message || query.text || query.body || '';

    // Fonnte format: { sender: "628123...", message: "...", device: "..." }
    // Wablas format: { phone: "628123...", message: "..." } atau { data: { phone, message } }
    // Starsender: { from: "628123...", text: "..." }
    // GOWA: { sender: "628123...@s.whatsapp.net", message: "..." }

    // Bersihkan JID suffix jika ada
    if (senderPhone && String(senderPhone).includes('@')) {
      senderPhone = String(senderPhone).split('@')[0];
    }

    senderPhone = normalizePhone(senderPhone);
    messageText = String(messageText || '').trim();

    if (!senderPhone || senderPhone.length < 8) {
      logger.warn('[WA Inbound] Webhook diterima tapi sender tidak valid: ' + JSON.stringify(body).substring(0, 400));
      return res.status(200).json({ ok: true, message: 'ignored — no sender' });
    }

    if (!messageText) {
      // Ada provider kirim image tanpa text — catat sebagai [Media]
      const hasMedia = body.image || body.media || body.document || body.data?.image;
      if (hasMedia) messageText = '[Media]';
      else return res.status(200).json({ ok: true, message: 'ignored — no message' });
    }

    // Opsional: verifikasi token jika diisi
    const expectedToken = String(
      require('../config/settingsManager').getSetting('http_wa_inbound_token', '') || ''
    ).trim();
    if (expectedToken) {
      const provided =
        String(query.token || query.secret || body.token || req.headers['x-webhook-token'] || '').trim();
      if (provided !== expectedToken) {
        return res.status(403).json({ ok: false, error: 'Invalid webhook token' });
      }
    }

    // Cari pelanggan dari DB
    let customerName = 'Pelanggan';
    let customerId = null;
    try {
      const cust = db.prepare('SELECT id, name FROM customers WHERE phone LIKE ? OR phone LIKE ?').get(`%${senderPhone.slice(-8)}%`, `%${senderPhone}%`);
      if (cust) { customerName = cust.name; customerId = cust.id; }
    } catch (e) {}

    // Tentukan gateway dari path atau header
    let gateway = 'http';
    const path = req.path || req.originalUrl || '';
    if (path.includes('fonnte')) gateway = 'fonnte';
    else if (path.includes('wablas')) gateway = 'wablas';
    else if (body.gateway) gateway = String(body.gateway);

    // Deduplicate: hindari simpan duplikat pesan yang sama dalam 5 detik terakhir
    try {
      const recent = db.prepare(
        "SELECT id FROM wa_chat_messages WHERE sender_phone=? AND message_text=? AND created_at >= datetime('now','-5 seconds') LIMIT 1"
      ).get(senderPhone, messageText);
      if (recent) return res.status(200).json({ ok: true, message: 'duplicate ignored' });
    } catch (e) {}

    db.prepare(`
      INSERT INTO wa_chat_messages (direction, gateway, sender_phone, recipient_phone, customer_id, customer_name, message_text, status)
      VALUES ('inbound', ?, ?, '', ?, ?, ?, 'read')
    `).run(gateway, senderPhone, customerId, customerName, messageText);

    logger.info(`[WA Inbound] Pesan masuk via ${gateway} dari ${senderPhone} (${customerName}): "${messageText.substring(0, 80)}"`);

    return res.status(200).json({ ok: true, gateway, sender: senderPhone });
  } catch (err) {
    logger.error('[WA Inbound] Error: ' + err.message);
    return res.status(200).json({ ok: true, message: 'error logged', error: err.message });
  }
}

module.exports = { handleInbound };
