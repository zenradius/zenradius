const axios = require('axios');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const metaService = require('./metaWhatsappService');

/**
 * HTTP WA Gateway — Fonnte / Wablas / custom
 * Kirim via HTTP POST, tanpa kelola device/Baileys sendiri.
 * Provider handle session, anti-ban & queue.
 */

function normalizePhone(phone) {
  return metaService.normalizePhone(phone);
}

async function sendViaFonnte(toPhone, messageText) {
  const token = String(getSetting('fonnte_token', '') || '').trim();
  const url = String(getSetting('fonnte_url', 'https://api.fonnte.com/send') || '').trim() || 'https://api.fonnte.com/send';
  if (!token) throw new Error('Fonnte token belum diisi (settings fonnte_token).');

  const phone = normalizePhone(toPhone);
  const res = await axios.post(url, {
    target: phone,
    message: messageText,
    countryCode: '62',
  }, {
    headers: { Authorization: token },
    timeout: 20000,
  });

  const ok = res.data && (res.data.status === true || res.data.success === true || res.status === 200);
  if (!ok) throw new Error('Fonnte error: ' + JSON.stringify(res.data).substring(0, 300));
  return true;
}

async function sendViaWablas(toPhone, messageText) {
  const domain = String(getSetting('wablas_domain', '') || '').trim();
  const token = String(getSetting('wablas_token', '') || '').trim();
  if (!domain || !token) throw new Error('Wablas domain/token belum diisi.');

  // Wablas v2: POST https://{domain}/api/v2/send-message
  const base = domain.replace(/\/$/, '').replace(/\/api.*$/, '');
  const url = `${base}/api/v2/send-message`;
  const phone = normalizePhone(toPhone);

  const res = await axios.post(url, {
    phone,
    message: messageText,
  }, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    timeout: 20000,
  });

  if (res.data && res.data.status === false) throw new Error('Wablas error: ' + JSON.stringify(res.data).substring(0, 300));
  return true;
}

function renderPayloadTemplate(template, vars) {
  if (!template || !String(template).trim()) return null;
  const raw = String(template).trim();
  try {
    let json = raw
      .replaceAll('{phone}', vars.phone)
      .replaceAll('{target}', vars.phone)
      .replaceAll('{message}', JSON.stringify(vars.message).slice(1, -1).replace(/"/g, '\\"'))
      .replaceAll('{text}', JSON.stringify(vars.message).slice(1, -1).replace(/"/g, '\\"'));
    // Allow {message_raw} for unescaped
    json = json.replaceAll('{message_raw}', vars.message).replaceAll('{text_raw}', vars.message);
    return JSON.parse(json);
  } catch (e) {
    throw new Error('Template payload JSON tidak valid: ' + e.message + ' — cek kurung & koma. Placeholder: {phone}, {message}, {message_raw}');
  }
}

function parseExtraHeaders(raw) {
  if (!raw || !String(raw).trim()) return {};
  try { return JSON.parse(String(raw).trim()); } catch (e) { throw new Error('Header tambahan JSON tidak valid: ' + e.message); }
}

async function sendViaCustomHttp(toPhone, messageText) {
  const url = String(getSetting('http_wa_url', '') || '').trim();
  const token = String(getSetting('http_wa_token', '') || '').trim();
  const method = String(getSetting('http_wa_method', 'POST') || 'POST').toUpperCase();
  const payloadTemplate = String(getSetting('http_wa_payload', '') || '').trim();
  const extraHeadersRaw = String(getSetting('http_wa_headers', '') || '').trim();
  const headerName = String(getSetting('http_wa_header_name', 'Authorization') || 'Authorization').trim() || 'Authorization';
  if (!url) throw new Error('HTTP WA URL belum diisi (http_wa_url).');

  const phone = normalizePhone(toPhone);
  const vars = { phone, message: messageText };

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers[headerName] = token;
  Object.assign(headers, parseExtraHeaders(extraHeadersRaw));

  let body = renderPayloadTemplate(payloadTemplate, vars);
  if (!body) body = { phone, target: phone, message: messageText, text: messageText };

  let res;
  if (method === 'GET') {
    res = await axios.get(url, { params: body, headers, timeout: 20000 });
  } else {
    res = await axios.post(url, body, { headers, timeout: 20000 });
  }

  if (res.data && res.data.status === false) throw new Error('HTTP WA error: ' + JSON.stringify(res.data).substring(0, 300));
  return true;
}

async function sendHttpWhatsApp(toPhone, messageText) {
  const gateway = String(getSetting('wa_gateway_type', 'baileys') || 'baileys').trim();

  if (gateway === 'fonnte') return sendViaFonnte(toPhone, messageText);
  if (gateway === 'wablas') return sendViaWablas(toPhone, messageText);
  if (gateway === 'http') return sendViaCustomHttp(toPhone, messageText);

  throw new Error('Gateway HTTP tidak dikenal: ' + gateway);
}

module.exports = {
  sendHttpWhatsApp,
  sendViaFonnte,
  sendViaWablas,
  sendViaCustomHttp,
};
