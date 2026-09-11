/** Server-side push notification pipeline for the native Android app. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const { CANONICAL_ROLES } = require('../middleware/authz');

db.exec(`
  CREATE TABLE IF NOT EXISTS mobile_push_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    device_id TEXT,
    fcm_token TEXT NOT NULL UNIQUE,
    platform TEXT DEFAULT 'android',
    app_version TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    last_seen_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON mobile_push_tokens(role, user_id, is_active);
  CREATE TABLE IF NOT EXISTS notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    reference_id TEXT,
    status TEXT NOT NULL DEFAULT 'persisted',
    send_attempted_at TEXT,
    provider_accepted_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_notification_events_owner
    ON notification_events(role, user_id, created_at DESC);
`);

const CHANNELS = Object.freeze({
  SERVICE: 'zr_service',       
  BILLING: 'zr_billing',       
  SUPPORT: 'zr_support',       
  ASSIGNMENT: 'zr_assignment', 
  SYSTEM: 'zr_system'          
});

/** Keys that must never appear in a push payload, whatever the caller passes. */
const FORBIDDEN_PAYLOAD_KEYS = /pass|token|secret|key|hash|credential|otp|pin/i;

/** Register (or refresh) a device token for an authenticated identity. */
function registerDevice({ userId, role, deviceId = null, fcmToken, appVersion = null }) {
  if (!userId || !role || !CANONICAL_ROLES.includes(role)) {
    throw new Error('registerDevice: invalid identity');
  }
  const token = String(fcmToken || '').trim();
  if (token.length < 20 || token.length > 4096) {
    throw new Error('registerDevice: invalid token');
  }

  db.prepare(`
    INSERT INTO mobile_push_tokens (user_id, role, device_id, fcm_token, app_version, is_active, last_error, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 1, NULL, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(fcm_token) DO UPDATE SET
      user_id = excluded.user_id,
      role = excluded.role,
      device_id = COALESCE(excluded.device_id, mobile_push_tokens.device_id),
      app_version = COALESCE(excluded.app_version, mobile_push_tokens.app_version),
      is_active = 1,
      last_error = NULL,
      updated_at = datetime('now','localtime'),
      last_seen_at = datetime('now','localtime')
  `).run(String(userId), role, deviceId, token, appVersion);

  return true;
}

/** Deactivate one token for the given identity (logout on one device). */
function unregisterDevice({ userId, role, fcmToken }) {
  const r = db.prepare(`
    UPDATE mobile_push_tokens
    SET is_active = 0, updated_at = datetime('now','localtime')
    WHERE fcm_token = ? AND user_id = ? AND role = ?
  `).run(String(fcmToken || ''), String(userId), role);
  return r.changes > 0;
}

/** Deactivate every token for an identity (password change / revoke-all). */
function unregisterAllForUser(userId, role) {
  const r = db.prepare(`
    UPDATE mobile_push_tokens
    SET is_active = 0, updated_at = datetime('now','localtime')
    WHERE user_id = ? AND role = ? AND is_active = 1
  `).run(String(userId), role);
  return r.changes;
}

function listActiveTokensForUser(userId, role) {
  return db.prepare(`
    SELECT fcm_token FROM mobile_push_tokens
    WHERE user_id = ? AND role = ? AND is_active = 1
  `).all(String(userId), role).map(r => r.fcm_token);
}

function listActiveTokensForRole(role) {
  return db.prepare(`
    SELECT fcm_token FROM mobile_push_tokens
    WHERE role = ? AND is_active = 1
  `).all(role).map(r => r.fcm_token);
}

function deactivateToken(fcmToken, reason) {
  db.prepare(`
    UPDATE mobile_push_tokens
    SET is_active = 0, last_error = ?, updated_at = datetime('now','localtime')
    WHERE fcm_token = ?
  `).run(String(reason || 'invalid').slice(0, 200), fcmToken);
}

function eventType(message) {
  const value = String(message?.data?.event || '').trim();
  return value.slice(0, 80) || 'system';
}

function referenceId(message) {
  const data = message?.data || {};
  for (const key of ['invoiceId', 'ticketId', 'referenceId']) {
    if (data[key] !== undefined && data[key] !== null) return String(data[key]).slice(0, 120);
  }
  return null;
}

function persistEvent(userId, role, message) {
  if (!userId || !CANONICAL_ROLES.includes(role)) {
    throw new Error('persistEvent: invalid identity');
  }
  return db.prepare(`
    INSERT INTO notification_events
      (user_id, role, event_type, channel, title, body, reference_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(userId),
    role,
    eventType(message),
    String(message?.channel || CHANNELS.SYSTEM).slice(0, 80),
    String(message?.title || 'ZenRadius').slice(0, 120),
    String(message?.body || '').slice(0, 500),
    referenceId(message)
  ).lastInsertRowid;
}

function markEventAttempted(eventId) {
  if (!eventId) return;
  db.prepare(`
    UPDATE notification_events
    SET status = CASE WHEN status = 'persisted' THEN 'send_attempted' ELSE status END,
        send_attempted_at = COALESCE(send_attempted_at, datetime('now','localtime'))
    WHERE id = ?
  `).run(eventId);
}

function markEventProviderAccepted(eventId) {
  if (!eventId) return;
  db.prepare(`
    UPDATE notification_events
    SET status = 'provider_accepted',
        provider_accepted_at = COALESCE(provider_accepted_at, datetime('now','localtime'))
    WHERE id = ?
  `).run(eventId);
}

function markEventFailed(eventId, error) {
  if (!eventId) return;
  db.prepare(`
    UPDATE notification_events
    SET status = 'failed', last_error = ?
    WHERE id = ? AND status NOT IN ('provider_accepted', 'delivered', 'read')
  `).run(String(error || 'provider request failed').slice(0, 200), eventId);
}

let cachedServiceAccount = null;
let cachedServiceAccountPath = null;
let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

function loadServiceAccount() {
  const configured = String(getSetting('fcm_service_account_path', '') || '').trim();
  if (!configured) return null;

  const resolved = path.isAbsolute(configured)
    ? configured
    : path.resolve(__dirname, '..', configured);

  if (cachedServiceAccount && cachedServiceAccountPath === resolved) return cachedServiceAccount;

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key || !sa.project_id) {
      logger.warn('[push] Service account file is missing client_email/private_key/project_id');
      return null;
    }
    cachedServiceAccount = sa;
    cachedServiceAccountPath = resolved;
    cachedAccessToken = null;
    return sa;
  } catch (e) {
    logger.warn(`[push] Cannot read FCM service account: ${e.message}`);
    return null;
  }
}

/** True when the server is able to send pushes. Never exposes why in detail. */
function isConfigured() {
  return Boolean(loadServiceAccount());
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  const sa = loadServiceAccount();
  if (!sa) throw new Error('FCM not configured');

  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessTokenExp - 60 > now) return cachedAccessToken;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });

  const res = await axios.post('https://oauth2.googleapis.com/token', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  cachedAccessToken = res.data.access_token;
  cachedAccessTokenExp = now + Number(res.data.expires_in || 3600);
  return cachedAccessToken;
}

/** Strip anything that must never travel in a push payload and coerce all */
function sanitizeData(data = {}) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (FORBIDDEN_PAYLOAD_KEYS.test(k)) continue;
    if (v === undefined || v === null) continue;
    out[String(k)] = String(v).slice(0, 500);
  }
  return out;
}

async function sendToTokens(tokens, { title, body, channel = CHANNELS.SYSTEM, data = {}, eventId = null }) {
  const sa = loadServiceAccount();
  const unique = Array.from(new Set((tokens || []).filter(Boolean)));
  if (unique.length > 0) markEventAttempted(eventId);
  if (!sa || unique.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, configured: Boolean(sa) };
  }

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    logger.warn(`[push] OAuth token error: ${e.message}`);
    markEventFailed(eventId, e.message);
    return { attempted: unique.length, sent: 0, failed: unique.length, configured: true };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;
  const safeData = {
    ...sanitizeData(data),
    channel: String(channel),
    title: String(title || 'ZenRadius').slice(0, 120),
    body: String(body || '').slice(0, 500)
  };

  let sent = 0;
  let failed = 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const slice = unique.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async (token) => {
      try {
        await axios.post(url, {
          message: {
            token,
            
            notification: { title: safeData.title, body: safeData.body },
            android: {
              priority: 'high',
              notification: { channel_id: String(channel), sound: 'default' }
            },
            data: safeData
          }
        }, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000
        });
        sent++;
        markEventProviderAccepted(eventId);
        db.prepare(`UPDATE mobile_push_tokens SET last_seen_at = datetime('now','localtime') WHERE fcm_token = ?`).run(token);
      } catch (e) {
        failed++;
        const code = e?.response?.data?.error?.details?.[0]?.errorCode
          || e?.response?.data?.error?.status
          || '';
        
        if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/i.test(String(code))) {
          deactivateToken(token, String(code));
        } else {
          logger.warn(`[push] send failed (${code || e.message})`);
        }
        if (sent === 0) markEventFailed(eventId, code || e.message);
      }
    }));
  }

  return { attempted: unique.length, sent, failed, configured: true };
}

/** Send to every active device of one identity. */
async function sendToUser(userId, role, message) {
  try {
    if (!CANONICAL_ROLES.includes(role)) return { attempted: 0, sent: 0, failed: 0 };
    const eventId = persistEvent(userId, role, message);
    return await sendToTokens(listActiveTokensForUser(userId, role), { ...message, eventId });
  } catch (e) {
    logger.warn(`[push] sendToUser error: ${e.message}`);
    return { attempted: 0, sent: 0, failed: 0 };
  }
}

/** Send to every active device of every user holding a role. */
async function sendToRole(role, message) {
  try {
    if (!CANONICAL_ROLES.includes(role)) return { attempted: 0, sent: 0, failed: 0 };
    const owners = db.prepare(`
      SELECT DISTINCT user_id FROM mobile_push_tokens
      WHERE role = ? AND is_active = 1
    `).all(role);
    const results = await Promise.all(owners.map(owner => sendToUser(owner.user_id, role, message)));
    return results.reduce((total, result) => ({
      attempted: total.attempted + result.attempted,
      sent: total.sent + result.sent,
      failed: total.failed + result.failed,
      configured: total.configured && result.configured !== false
    }), { attempted: 0, sent: 0, failed: 0, configured: true });
  } catch (e) {
    logger.warn(`[push] sendToRole error: ${e.message}`);
    return { attempted: 0, sent: 0, failed: 0 };
  }
}

/** Fire-and-forget wrapper. Use this from business-transaction paths so a */
function notifyAsync(fn) {
  Promise.resolve()
    .then(fn)
    .catch(e => logger.warn(`[push] async notify error: ${e.message}`));
}

const EVENTS = Object.freeze({
  PAYMENT_SUCCESS: 'payment_success',
  INVOICE_NEW: 'invoice_new',
  INVOICE_DUE: 'invoice_due',
  TICKET_NEW: 'ticket_new',
  TICKET_UPDATE: 'ticket_update',
  ASSIGNMENT_NEW: 'assignment_new',
  SERVICE_SUSPENDED: 'service_suspended',
  SERVICE_RESTORED: 'service_restored',
  ANNOUNCEMENT: 'announcement'
});

function notifyPaymentSuccess({ customerId, invoiceId, periodText, amountText }) {
  notifyAsync(async () => {
    const msg = {
      channel: CHANNELS.BILLING,
      title: 'Pembayaran berhasil',
      body: `Tagihan periode ${periodText || '-'} sebesar Rp ${amountText || '-'} telah lunas.`,
      data: { event: EVENTS.PAYMENT_SUCCESS, invoiceId }
    };
    await sendToUser(customerId, 'pelanggan', msg);
    
    const staffMsg = {
      channel: CHANNELS.BILLING,
      title: 'Pembayaran diterima',
      body: `Invoice #${invoiceId} periode ${periodText || '-'} telah dibayar.`,
      data: { event: EVENTS.PAYMENT_SUCCESS, invoiceId }
    };
    await sendToRole('admin', staffMsg);
    await sendToRole('customer_service', staffMsg);
  });
}

function notifyTicketCreated({ ticketId, customerId, subject }) {
  notifyAsync(async () => {
    const msg = {
      channel: CHANNELS.SUPPORT,
      title: 'Tiket baru',
      body: `Tiket #${ticketId}: ${String(subject || '').slice(0, 80)}`,
      data: { event: EVENTS.TICKET_NEW, ticketId }
    };
    await sendToRole('admin', msg);
    await sendToRole('customer_service', msg);
    await sendToRole('teknisi', msg);
    await sendToUser(customerId, 'pelanggan', {
      channel: CHANNELS.SUPPORT,
      title: 'Tiket diterima',
      body: `Tiket #${ticketId} telah dibuat dan sedang menunggu penanganan.`,
      data: { event: EVENTS.TICKET_UPDATE, ticketId }
    });
  });
}

function notifyTicketUpdated({ ticketId, customerId, status, technicianId = null }) {
  notifyAsync(async () => {
    const statusLabel = ({
      open: 'Terbuka', in_progress: 'Dalam penanganan', resolved: 'Selesai'
    })[String(status)] || String(status || '-');
    await sendToUser(customerId, 'pelanggan', {
      channel: CHANNELS.SUPPORT,
      title: 'Pembaruan tiket',
      body: `Tiket #${ticketId} kini: ${statusLabel}.`,
      data: { event: EVENTS.TICKET_UPDATE, ticketId }
    });
    if (technicianId) {
      await sendToUser(technicianId, 'teknisi', {
        channel: CHANNELS.ASSIGNMENT,
        title: 'Penugasan tiket',
        body: `Tiket #${ticketId} ditugaskan kepada Anda.`,
        data: { event: EVENTS.ASSIGNMENT_NEW, ticketId }
      });
    }
  });
}

function notifyServiceSuspended({ customerId }) {
  notifyAsync(() => sendToUser(customerId, 'pelanggan', {
    channel: CHANNELS.SERVICE,
    title: 'Layanan diisolir',
    body: 'Layanan internet Anda diisolir karena tagihan belum dibayar. Buka aplikasi untuk membayar.',
    data: { event: EVENTS.SERVICE_SUSPENDED }
  }));
}

function notifyServiceRestored({ customerId }) {
  notifyAsync(() => sendToUser(customerId, 'pelanggan', {
    channel: CHANNELS.SERVICE,
    title: 'Layanan aktif kembali',
    body: 'Layanan internet Anda telah aktif kembali. Terima kasih.',
    data: { event: EVENTS.SERVICE_RESTORED }
  }));
}

function notifyInvoiceDue({ customerId, invoiceId, periodText, amountText, isNew = false }) {
  notifyAsync(() => sendToUser(customerId, 'pelanggan', {
    channel: CHANNELS.BILLING,
    title: isNew ? 'Tagihan baru' : 'Pengingat tagihan',
    body: `Tagihan periode ${periodText || '-'} sebesar Rp ${amountText || '-'} menunggu pembayaran.`,
    data: { event: isNew ? EVENTS.INVOICE_NEW : EVENTS.INVOICE_DUE, invoiceId }
  }));
}

module.exports = {
  CHANNELS,
  EVENTS,
  isConfigured,
  registerDevice,
  unregisterDevice,
  unregisterAllForUser,
  sendToUser,
  sendToRole,
  sendToTokens,
  notifyAsync,
  notifyPaymentSuccess,
  notifyTicketCreated,
  notifyTicketUpdated,
  notifyServiceSuspended,
  notifyServiceRestored,
  notifyInvoiceDue
  ,persistEvent
};
