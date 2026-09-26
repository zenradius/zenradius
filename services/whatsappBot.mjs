import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const { logger } = require('../config/logger.js');
const { getSetting, getNowLocal, formatDateLocal, getCurrentDateInTimezone } = require('../config/settingsManager.js');
const db = require('../config/database.js');
const customerDevice = require('./customerDeviceService.js');
const { WaLidStore } = require('./waLidStore.js');
const billingSvc = require('./billingService.js');
const mikrotikSvc = require('./mikrotikService.js');
const customerSvc = require('./customerService.js');
const agentSvc = require('./agentService.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Cache Retry Counter untuk Baileys Signal Enkripsi (Mencegah "Waiting for this message" / Pesan tidak terbaca)
class SimpleRetryCache {
  constructor(ttlMs = 600000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }
  get(key) {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() - item.time > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return item.val;
  }
  set(key, val) {
    this.cache.set(key, { val, time: Date.now() });
  }
  del(key) {
    this.cache.delete(key);
  }
}
const msgRetryCounterCache = new SimpleRetryCache();

const sentMessageMap = new Map();
function cacheSentMessage(key, message) {
  if (!key || !key.id || !message) return;
  const storeKey = `${key.remoteJid || ''}:${key.id}`;
  sentMessageMap.set(storeKey, message);
  if (sentMessageMap.size > 2000) {
    const firstKey = sentMessageMap.keys().next().value;
    sentMessageMap.delete(firstKey);
  }
}

// Rate Limiting untuk WhatsApp Bot Self-Service
const rateLimitStore = new Map(); // Format: { phone: { count: 0, lastReset: timestamp } }
const MAX_COMMANDS_PER_MINUTE = 10;
const COMMAND_COOLDOWN_MS = 2000; // 2 detik cooldown antar perintah
const commandCooldownStore = new Map(); // Format: { phone: lastCommandTimestamp }

// Multi-turn conversation state (contekstual bertahap)
const conversationStateStore = new Map(); // Format: { phone: { action, data, expiresAt } }
const CONVERSATION_STATE_TTL_MS = 5 * 60 * 1000; // 5 menit

function getConversationState(phone) {
  if (!phone) return null;
  const state = conversationStateStore.get(phone);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    conversationStateStore.delete(phone);
    return null;
  }
  return state;
}

function setConversationState(phone, action, data = {}) {
  if (!phone) return;
  conversationStateStore.set(phone, {
    action,
    data,
    expiresAt: Date.now() + CONVERSATION_STATE_TTL_MS
  });
}

function clearConversationState(phone) {
  if (!phone) return;
  conversationStateStore.delete(phone);
}

// AI LLM (Gemini) integration
const GEMINI_MODEL = 'gemini-3.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Definisi function calling untuk Gemini.
 * Model dapat memanggil fungsi ini secara langsung; kita eksekusi di sisi klien.
 */
const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'get_customer_invoices',
        description: 'Mengambil daftar tagihan/invoice pelanggan berdasarkan nomor telepon atau tag billing.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_onu_status',
        description: 'Mengecek status perangkat ONU pelanggan (online/offline, RX power, uptime PPPoE, jumlah user WiFi).',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'reboot_onu',
        description: 'Merestart perangkat ONU pelanggan dari jarak jauh.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'update_wifi_ssid',
        description: 'Mengubah nama WiFi (SSID) pelanggan.',
        parameters: {
          type: 'object',
          properties: {
            targetSSID: { type: 'string', description: 'Nama WiFi baru yang diinginkan pelanggan' }
          },
          required: ['targetSSID']
        }
      },
      {
        name: 'update_wifi_password',
        description: 'Mengubah password WiFi pelanggan.',
        parameters: {
          type: 'object',
          properties: {
            newPassword: { type: 'string', description: 'Password WiFi baru, minimal 8 karakter' }
          },
          required: ['newPassword']
        }
      },
      {
        name: 'escalate_to_technician',
        description: 'Meneruskan keluhan serius ke tim teknisi jika pelanggan meminta bantuan manusia atau ada gangguan berat.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    ]
  }
];

/**
 * Eksekusi function call dari Gemini ke sistem ZenRadius.
 * Mengembalikan hasil dalam format yang bisa dikirim kembali ke model.
 */
async function executeGeminiFunction(ctx, functionName, args = {}) {
  if (!ctx) return { error: 'Konteks pelanggan tidak ditemukan. Nomor belum terdaftar.' };

  try {
    switch (functionName) {
      case 'get_customer_invoices': {
        const invoices = billingSvc.getInvoicesByAny(ctx.billingKey);
        return {
          invoices: (invoices || []).slice(0, 5).map(i => ({
            id: i.id,
            period: `${i.period_month}/${i.period_year}`,
            amount: i.amount,
            status: i.status
          })),
          total_unpaid: (invoices || []).filter(i => i.status === 'unpaid').reduce((s, i) => s + Number(i.amount || 0), 0)
        };
      }
      case 'get_onu_status': {
        const data = await customerDevice.getCustomerDeviceData(ctx.deviceKey);
        return {
          status: data?.status || 'Tidak ditemukan',
          rx_power: data?.rxPower || '-',
          pppoe_uptime: data?.pppoeUptime || '-',
          total_wifi_users: data?.totalAssociations || '0',
          ssid: data?.ssid || '-'
        };
      }
      case 'reboot_onu': {
        const result = await customerDevice.requestReboot(ctx.deviceKey);
        return { success: true, message: result?.message || 'Perintah reboot dikirim' };
      }
      case 'update_wifi_ssid': {
        const newSSID = String(args?.targetSSID || '').trim();
        if (!newSSID) return { error: 'Nama WiFi baru belum diisi' };
        const ok = await customerDevice.updateSSID(ctx.deviceKey, newSSID);
        return { success: ok, message: ok ? `SSID diubah menjadi ${newSSID}` : 'Gagal mengubah SSID' };
      }
      case 'update_wifi_password': {
        const newPass = String(args?.newPassword || '').trim();
        if (!newPass || newPass.length < 8) return { error: 'Password harus minimal 8 karakter' };
        const ok = await customerDevice.updatePassword(ctx.deviceKey, newPass);
        return { success: ok, message: ok ? 'Password berhasil diubah' : 'Gagal mengubah password' };
      }
      case 'escalate_to_technician': {
        const cust = customerSvc.findCustomerByAny(ctx.billingKey || ctx.deviceKey);
        const alertBody = `👤 Pelanggan: ${cust ? cust.name : '-'}\n📍 Tag: ${ctx.deviceKey}\n🤖 Eskalasi AI: Pelanggan meminta bantuan manusia`;
        await sendMonitoringAlert(alertBody, 'high');
        const groupJid = getSetting('whatsapp_tech_group_jid', '');
        if (groupJid && currentSock && whatsappStatus.connection === 'open') {
          await currentSock.sendMessage(groupJid, { text: `🚨 *ESKALASI AI*\n\n${alertBody}` });
        }
        return { success: true, message: 'Diteruskan ke tim teknisi' };
      }
      default:
        return { error: 'Fungsi tidak dikenal' };
    }
  } catch (e) {
    logger.error(`[WA AI Function] ${functionName} error: ` + (e.message || e));
    return { error: e.message || 'Terjadi kesalahan saat eksekusi fungsi' };
  }
}

/**
 * Kirim pesan ke Gemini dengan function calling.
 * Mengembalikan teks balasan akhir dari model setelah semua function call diselesaikan.
 */
async function callGeminiAI(systemPrompt, userMessage, ctx, sock, lidStore) {
  const apiKey = getSetting('gemini_api_key', '');
  if (!apiKey) return null;

  const url = `${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`;
  const contents = [{ role: 'user', parts: [{ text: userMessage }] }];

  try {
    let payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: GEMINI_TOOLS,
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'low' },
        maxOutputTokens: 512
      }
    };

    const { data } = await axios.post(url, payload, { timeout: 20000 });
    const candidate = data?.candidates?.[0];
    if (!candidate) return null;

    // Jika ada function call, eksekusi lalu kirim hasilnya kembali ke model
    const parts = candidate.content?.parts || [];
    const functionCallPart = parts.find(p => p.functionCall);

    if (functionCallPart) {
      const fc = functionCallPart.functionCall;
      logger.info(`[WA AI] Function call: ${fc.name} args=${JSON.stringify(fc.args || {})}`);

      // Eksekusi fungsi
      const result = await executeGeminiFunction(ctx, fc.name, fc.args || {});

      // Bangun riwayat percakapan dengan function response
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name: fc.name, args: fc.args || {} } }]
      });
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: fc.name,
            response: { output: result }
          }
        }]
      });

      // Panggil lagi untuk mendapatkan respons teks akhir
      payload.contents = contents;
      const { data: secondData } = await axios.post(url, payload, { timeout: 20000 });
      const secondCandidate = secondData?.candidates?.[0];
      const finalText = secondCandidate?.content?.parts?.[0]?.text || '';
      return finalText || null;
    }

    // Tidak ada function call, kembalikan teks langsung
    return candidate.content?.parts?.[0]?.text || null;
  } catch (e) {
    logger.error('[WA AI] Gemini call failed: ' + (e.message || e));
    return null;
  }
}

function buildGeminiSystemPrompt(ctx, isAdmin) {
  const company = getSetting('company_header', 'ZenRadius');
  const today = getNowLocal();

  let contextInfo = '';
  if (ctx) {
    try {
      const cust = customerSvc.findCustomerByAny(ctx.billingKey || ctx.deviceKey);
      const invoices = billingSvc.getInvoicesByAny(ctx.billingKey);
      const unpaid = (invoices || []).filter(i => i.status === 'unpaid');
      contextInfo =
        `Nama pelanggan: ${cust ? cust.name : '-'}\n` +
        `Nomor/tag: ${ctx.billingKey || '-'}\n` +
        `Total tagihan aktif: ${invoices ? invoices.length : 0}\n` +
        `Tagihan belum lunas: ${unpaid.length}\n` +
        `Total tagihan belum lunas: Rp ${unpaid.reduce((s, i) => s + Number(i.amount || 0), 0).toLocaleString('id-ID')}\n`;
    } catch (_) {}
  }

  return `Kamu adalah asisten AI WhatsApp resmi ${company}.\n` +
    `Tanggal/waktu sekarang: ${today}.\n` +
    `Konteks pelanggan saat ini:\n${contextInfo || 'Belum ada konteks pelanggan.'}\n\n` +
    `Kamu memiliki fungsi yang bisa dipanggil untuk membantu pelanggan:\n` +
    `- get_customer_invoices: ambil daftar tagihan pelanggan\n` +
    `- get_onu_status: cek status modem/ONU pelanggan\n` +
    `- reboot_onu: restart modem/ONU pelanggan\n` +
    `- update_wifi_ssid: ubah nama WiFi pelanggan\n` +
    `- update_wifi_password: ubah password WiFi pelanggan\n` +
    `- escalate_to_technician: eskalasi keluhan serius ke teknisi\n\n` +
    `Aturan penggunaan fungsi:\n` +
    `- Jika user bertanya tagihan, panggil get_customer_invoices lalu rangkum hasilnya.\n` +
    `- Jika user bertanya status internet/lambat/mati, panggil get_onu_status lalu beri diagnosa awal.\n` +
    `- Jika user ingin restart modem, panggil reboot_onu.\n` +
    `- Jika user ingin ganti nama WiFi, panggil update_wifi_ssid. Jika belum menyebutkan nama baru, minta dulu.\n` +
    `- Jika user ingin ganti password WiFi, panggil update_wifi_password. Jika belum menyebutkan password baru, minta dulu.\n` +
    `- Jika keluhan berat atau user minta manusia, panggil escalate_to_technician.\n` +
    `- Jika hanya sapaan/obrolan ringan, cukup balas teks tanpa memanggil fungsi.\n\n` +
    `Aturan balasan:\n` +
    `- Gunakan bahasa Indonesia yang ramah, singkat, dan jelas.\n` +
    `- Jangan sebutkan istilah teknis rumit.\n` +
    `- Jika user menyapa (halo, pagi, dll), sapa balik dan tawarkan bantuan.\n` +
    `- Setelah memanggil fungsi, jangan lupa rangkum hasilnya untuk pelanggan.`;
}

function checkRateLimit(phone) {
  const now = Date.now();
  const userLimit = rateLimitStore.get(phone);

  if (!userLimit) {
    rateLimitStore.set(phone, { count: 1, lastReset: now });
    return { allowed: true, remaining: MAX_COMMANDS_PER_MINUTE - 1 };
  }

  // Reset counter setiap menit
  if (now - userLimit.lastReset >= 60000) {
    rateLimitStore.set(phone, { count: 1, lastReset: now });
    return { allowed: true, remaining: MAX_COMMANDS_PER_MINUTE - 1 };
  }

  // Cek limit
  if (userLimit.count >= MAX_COMMANDS_PER_MINUTE) {
    const resetTime = userLimit.lastReset + 60000;
    const waitTime = Math.ceil((resetTime - now) / 1000);
    return { allowed: false, waitTime };
  }

  // Increment counter
  userLimit.count++;
  return { allowed: true, remaining: MAX_COMMANDS_PER_MINUTE - userLimit.count };
}

function checkCommandCooldown(phone) {
  const now = Date.now();
  const lastCommand = commandCooldownStore.get(phone);

  if (!lastCommand) {
    commandCooldownStore.set(phone, now);
    return { allowed: true };
  }

  const elapsed = now - lastCommand;
  if (elapsed < COMMAND_COOLDOWN_MS) {
    const waitTime = Math.ceil((COMMAND_COOLDOWN_MS - elapsed) / 1000);
    return { allowed: false, waitTime };
  }

  commandCooldownStore.set(phone, now);
  return { allowed: true };
}

function getPhoneFromKey(key) {
  if (!key) return null;
  const remoteJid = key.remoteJid || key;
  if (!remoteJid) return null;

  // Extract phone number from JID
  const [user, host] = remoteJid.split('@');
  if (!user || !host) return null;

  // Remove non-digits
  const phone = user.replace(/\D/g, '');
  if (!phone) return null;

  // Convert 0 to 62
  if (phone.startsWith('0')) {
    return '62' + phone.slice(1);
  }

  return phone;
}

function waBrand() {
  const companyHeader = getSetting('company_header', 'ZenRadius');
  const footerInfo = getSetting('footer_info', 'ZenRadius - All Rights Reserved');
  const sep = '─'.repeat(30);
  return { companyHeader, footerInfo, sep };
}

function waWrap(title, body) {
  const { companyHeader, footerInfo, sep } = waBrand();
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  const head = t ? `${t}\n${sep}\n🏢 *${companyHeader}*\n${sep}\n` : `🏢 *${companyHeader}*\n${sep}\n`;
  const foot = footerInfo ? `\n${sep}\n${footerInfo}` : '';
  return head + b + foot;
}

function waAutoWrap(text) {
  const { sep } = waBrand();
  const t = String(text || '').trim();
  if (!t) return t;
  if (t.includes(sep)) return t;
  return waWrap('', t);
}

function getMessageText(m) {
  const msg = m.message;
  if (!msg) return '';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  return '';
}

/** Field tambahan Baileys 6.7: senderPn = JID nomor, senderLid = JID @lid */
function normalizeKey(key) {
  if (!key) return {};
  return {
    remoteJid: key.remoteJid,
    senderPn: key.senderPn || null,
    senderLid: key.senderLid || null
  };
}

async function resolveCustomerTag(key, lidStore) {
  const { remoteJid, senderPn, senderLid } = normalizeKey(key);
  if (!remoteJid || remoteJid.endsWith('@g.us')) return null;

  const tryPnAndCache = async (pnJid, lidJid) => {
    const digits = customerDevice.phoneFromPnJid(pnJid);
    if (!digits) return null;

    // 1. Coba cari di Billing Database dulu
    const customer = customerSvc.findCustomerByAny(digits);
    if (customer && (customer.genieacs_tag || customer.pppoe_username)) {
      const tag = customer.genieacs_tag || customer.pppoe_username || digits;
      if (lidJid) lidStore.set(lidJid, tag);
      lidStore.set(pnJid, tag);
      return tag;
    }

    // 2. Fallback: Cari langsung di GenieACS (berdasarkan tag yang mirip nomor)
    const found = await customerDevice.findDeviceWithTagVariants(digits);
    if (!found) return null;
    if (lidJid) lidStore.set(lidJid, found.canonicalTag);
    lidStore.set(pnJid, found.canonicalTag);
    return found.canonicalTag;
  };

  if (remoteJid.endsWith('@s.whatsapp.net')) {
    const found = await tryPnAndCache(remoteJid, senderLid && senderLid.endsWith('@lid') ? senderLid : null);
    if (found) return found;
    return lidStore.get(remoteJid);
  }

  if (remoteJid.endsWith('@lid')) {
    const cached = lidStore.get(remoteJid);
    if (cached) return cached;
    if (senderPn && senderPn.endsWith('@s.whatsapp.net')) {
      return tryPnAndCache(senderPn, remoteJid);
    }
    return null;
  }

  return null;
}

async function resolveCustomerContext(key, lidStore) {
  const { remoteJid, senderPn, senderLid } = normalizeKey(key);
  if (!remoteJid || remoteJid.endsWith('@g.us')) return null;

  const pnDigits = senderPn && senderPn.endsWith('@s.whatsapp.net') ? customerDevice.phoneFromPnJid(senderPn) : null;
  const remoteDigits = remoteJid.endsWith('@s.whatsapp.net') ? customerDevice.phoneFromPnJid(remoteJid) : null;
  const digits = pnDigits || remoteDigits || null;

  const cached =
    (remoteJid.endsWith('@lid') ? lidStore.get(remoteJid) : null) ||
    (senderLid && senderLid.endsWith('@lid') ? lidStore.get(senderLid) : null) ||
    (senderPn && senderPn.endsWith('@s.whatsapp.net') ? lidStore.get(senderPn) : null) ||
    (remoteJid.endsWith('@s.whatsapp.net') ? lidStore.get(remoteJid) : null) ||
    null;

  let customer = null;
  if (digits) customer = customerSvc.findCustomerByAny(digits);
  if (!customer && cached) customer = customerSvc.findCustomerByAny(cached);

  let billingKey = digits || null;
  if (!billingKey && customer && customer.phone) billingKey = String(customer.phone);
  if (!billingKey && cached && /^\d+$/.test(String(cached))) billingKey = String(cached);

  let deviceKey =
    (customer && (customer.genieacs_tag || customer.pppoe_username) ? (customer.genieacs_tag || customer.pppoe_username) : null) ||
    cached ||
    digits ||
    null;

  if (!deviceKey) return null;

  if (digits) {
    const tagToCache = (customer && (customer.genieacs_tag || customer.pppoe_username)) ? (customer.genieacs_tag || customer.pppoe_username) : deviceKey;
    const pnJid = senderPn && senderPn.endsWith('@s.whatsapp.net') ? senderPn : (remoteJid.endsWith('@s.whatsapp.net') ? remoteJid : null);
    const lidJid = remoteJid.endsWith('@lid') ? remoteJid : (senderLid && senderLid.endsWith('@lid') ? senderLid : null);
    if (pnJid) lidStore.set(pnJid, tagToCache);
    if (lidJid) lidStore.set(lidJid, tagToCache);
  }

  return { billingKey: billingKey || deviceKey, deviceKey };
}

function formatInfo(data) {
  if (!data) return waWrap('📡 *STATUS ONU*', '❌ Data perangkat tidak ditemukan di GenieACS.');

  const lines = [
    `🟢 *Status:* ${data.status}`,
    `📶 *SSID:* ${data.ssid}`,
    `⏱️ *Last Inform:* ${data.lastInform}`,
    `📡 *RX Power:* ${data.rxPower}`,
    `🌐 *PPPoE IP:* ${data.pppoeIP}`,
    `👤 *PPPoE User:* ${data.pppoeUsername}`,
    `⏳ *Uptime:* ${data.uptime}`,
    `⏳ *PPPoE Uptime:* ${data.pppoeUptime || '-'}`,
    `📱 *User WiFi (2.4G):* ${data.totalAssociations}`,
    `🔧 *Model:* ${data.model}`,
    `🏷️ *Serial Number:* ${data.serialNumber}`,
    `💾 *Firmware:* ${data.softwareVersion}`,
    `📍 *Tag:* ${data.lokasi}`
  ];
  return waWrap('📡 *STATUS ONU*', lines.join('\n'));
}

function formatCekTerhubung(data) {
  if (!data) return waWrap('👥 *PERANGKAT TERHUBUNG*', '❌ Data tidak tersedia.');
  const list = data.connectedUsers || [];

  if (list.length === 0) {
    return waWrap('👥 *PERANGKAT TERHUBUNG*', '⚠️ Tidak ada entri host/perangkat terhubung di data ONU.');
  }

  const content = `📊 *${list.length} perangkat tercatat:*\n`;
  const rows = list.slice(0, 25).map((u, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `${num}. 📱 ${u.hostname}\n   🌐 ${u.ip} | ${u.status}`;
  }).join('\n\n');
  const tail = list.length > 25 ? `\n\n_…dan ${list.length - 25} perangkat lainnya_` : '';
  return waWrap('👥 *PERANGKAT TERHUBUNG*', content + rows + tail);
}

function formatBillingSummary(stats) {
  const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });

  return waWrap(
    '💰 *RINGKASAN BILLING*',
    `📈 *Total Pendapatan:* ${formatter.format(stats.totalRevenue)}\n` +
    `📅 *Bulan Ini:* ${formatter.format(stats.thisMonth)}\n` +
    `⏳ *Piutang (Pending):* ${formatter.format(stats.pendingAmount)}\n` +
    `🧾 *Tagihan Belum Lunas:* ${stats.unpaidCount} invoice\n\n` +
    `💡 _Gunakan perintah lain untuk detail._`
  );
}

function formatCustomerInvoices(invoices, name) {
  const title = `🧾 *STATUS TAGIHAN*\n👤 *${name}*`;
  if (!invoices || invoices.length === 0) return waWrap(title, "✅ Tidak ada tagihan. Terima kasih!");

  const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });

  const list = invoices.map(inv => {
    const status = inv.status === 'paid' ? '✅ LUNAS' : '❌ BELUM BAYAR';
    return `📅 *Periode:* ${inv.period_month}/${inv.period_year}\n💰 *Total:* ${formatter.format(inv.amount)}\n📌 *Status:* ${status}\n🆔 *ID:* ${inv.id}`;
  }).join('\n\n');

  return waWrap(title, list + `\n\n💡 _Gunakan ID Tagihan saat konfirmasi pembayaran_`);
}

function formatActiveMikrotik(pppoe, hotspot) {
  const { sep } = waBrand();
  const p = `👥 *PPPoE Active:* ${pppoe.length} user\n` + pppoe.slice(0, 10).map(u => `  ◦ ${u.name} (${u.address})`).join('\n') + (pppoe.length > 10 ? '\n  _...dll_' : '');
  const h = `\n\n🔥 *Hotspot Active:* ${hotspot.length} user\n` + hotspot.slice(0, 10).map(u => `  ◦ ${u.user} (${u.address})`).join('\n') + (hotspot.length > 10 ? '\n  _...dll_' : '');
  return waWrap('🌐 *MIKROTIK ACTIVE*', p + h);
}

function parseNumbers(input) {
  if (Array.isArray(input)) return input.map(x => String(x).trim()).filter(Boolean);
  if (typeof input === 'string' && input.trim()) {
    return input.split(',').map(x => x.trim()).filter(Boolean);
  }
  return [];
}

function getWhatsappAdminNumbers() {
  const primary = parseNumbers(getSetting('whatsapp_admin_numbers', []));
  const legacy = parseNumbers(getSetting('admins', []));
  const companyPhone = parseNumbers(getSetting('company_phone', ''));
  let dbAdmin = [];
  try {
    const raw = db.getAppSetting('whatsapp_admin_numbers', null) || db.getAppSetting('admins', null);
    if (raw) dbAdmin = parseNumbers(raw);
  } catch (e) {}

  const combined = Array.from(new Set([...primary, ...legacy, ...companyPhone, ...dbAdmin]));
  return combined;
}

function loadWhatsappAdminSet(lidStore) {
  const list = getWhatsappAdminNumbers();
  const set = new Set();
  for (const n of list) {
    const s = String(n).trim();
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 8) {
      for (const c of customerDevice.expandTagCandidates(digits)) {
        set.add(c);
      }
    } else if (s) {
      set.add(s);
    }
  }
  if (lidStore && typeof lidStore.getAll === 'function') {
    const storeMap = lidStore.getAll() || {};
    for (const [key, val] of Object.entries(storeMap)) {
      const valDigits = String(val || '').replace(/\D/g, '');
      if (valDigits) {
        for (const c of customerDevice.expandTagCandidates(valDigits)) {
          if (set.has(c)) {
            set.add(key);
            set.add(key.split('@')[0]);
          }
        }
      }
    }
  }
  return set;
}

/** Admin dikenali dari nomor WA (bukan @lid saja). Pakai senderPn atau remoteJid @s.whatsapp.net / @lid */
function isWhatsappAdminKey(key, adminSet, sock, lidStore) {
  if (sock && sock.user && sock.user.id) {
    const selfJid = sock.user.id.split(':')[0];
    const selfLid = sock.user.lid ? sock.user.lid.split('@')[0] : null;
    const nk = normalizeKey(key);
    const sender = nk.senderPn || nk.remoteJid;
    if (sender) {
      const senderUser = sender.split('@')[0];
      if (senderUser === selfJid || (selfLid && senderUser === selfLid)) {
        return true; // Pesan dari nomor bot sendiri (self-chat) selalu dianggap admin
      }
    }
  }
  if (!adminSet || adminSet.size === 0) return false;
  const nk = normalizeKey(key);
  
  // 1. Cek JID nomor HP langsung
  const pnJid =
    nk.senderPn && nk.senderPn.endsWith('@s.whatsapp.net')
      ? nk.senderPn
      : nk.remoteJid && nk.remoteJid.endsWith('@s.whatsapp.net')
        ? nk.remoteJid
        : null;

  let digits = null;
  if (pnJid) {
    digits = customerDevice.phoneFromPnJid(pnJid);
  }

  // 2. Cek jika LID JID
  if (nk.remoteJid && nk.remoteJid.endsWith('@lid')) {
    const lidUser = nk.remoteJid.split('@')[0];
    if (adminSet.has(nk.remoteJid) || adminSet.has(lidUser)) return true;
    if (lidStore) {
      const cachedTag = lidStore.get(nk.remoteJid) || lidStore.get(lidUser);
      if (cachedTag) {
        digits = String(cachedTag).replace(/\D/g, '');
      }
    }
  }

  if (!digits) return false;
  for (const c of customerDevice.expandTagCandidates(digits)) {
    if (adminSet.has(c)) return true;
  }
  return false;
}

/** Levenshtein distance sederhana untuk toleransi typo command (mis. "cektagian" -> "cektagihan"). */
function levenshtein(a, b) {
  a = String(a || ''); b = String(b || '');
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** Kata kunci command resmi (untuk fuzzy typo-match single word). */
const KNOWN_COMMAND_WORDS = [
  'menu', 'bantuan', 'help', 'cektagihan', 'info', 'cekstatus', 'cekonu', 'statusonu',
  'cekterhubung', 'gantissid', 'gantisandi', 'daftar', 'reboot', 'restartonu'
];

/** Frasa bahasa natural (sinonim) -> command pelanggan. Dicek via "includes" pada teks yang sudah dinormalisasi. */
const NATURAL_LANGUAGE_INTENTS = [
  { cmd: 'cektagihan', phrases: ['tagihan saya', 'tagihan ku', 'cek tagihan', 'lihat tagihan', 'info tagihan', 'berapa tagihan', 'tagihan berapa', 'mau bayar', 'belum bayar', 'sisa tagihan', 'jumlah tagihan', 'tagihan bulan ini', 'tagihan masih ada', 'mau cek tagihan'] },
  { cmd: 'info', phrases: ['cek status', 'status wifi', 'status internet', 'status onu', 'cek onu', 'kondisi internet', 'kondisi wifi', 'internet saya', 'wifi saya'] },
  { cmd: 'cekterhubung', phrases: ['perangkat terhubung', 'device terhubung', 'siapa saja yang konek', 'user terhubung', 'siapa yang pakai', 'berapa user konek'] },
  { cmd: 'gantisandi', phrases: ['ganti password wifi', 'ganti sandi wifi', 'ubah password wifi', 'ubah sandi wifi', 'password wifi baru', 'ganti pass wifi', 'ganti pass hotspot'] },
  { cmd: 'gantissid', phrases: ['ganti nama wifi', 'ubah nama wifi', 'ganti ssid', 'ganti nama hotspot'] },
  { cmd: 'reboot', phrases: ['restart modem', 'restart onu', 'reboot modem', 'reboot onu', 'restart wifi', 'reboot wifi', 'mati nyalain modem'] },
  { cmd: 'menu', phrases: ['menu bantuan', 'daftar perintah', 'perintah apa saja', 'bisa apa saja', 'command list', 'bantuan', 'help', 'apa aja'] },
  { cmd: 'terimakasih', phrases: ['terima kasih', 'thanks', 'thank you', 'makasih', ' trims'] },
  { cmd: 'oke', phrases: ['oke siap', 'oke thanks', 'siap terima kasih', 'baik terima kasih', 'oke terima kasih'] }
];

/** Frasa yang mengindikasikan komplain gangguan jaringan (untuk auto-diagnosa). */
const NETWORK_COMPLAINT_PHRASES = [
  'internet mati', 'internet lemot', 'internet lambat', 'internet putus', 'internet gangguan',
  'wifi mati', 'wifi lemot', 'wifi lambat', 'wifi putus', 'wifi gangguan', 'wifi ga bisa', 'wifi gabisa',
  'ga bisa connect', 'gabisa connect', 'tidak bisa konek', 'tidak konek', 'gak konek', 'ga konek',
  'gak ada internet', 'ga ada internet', 'jaringan mati', 'jaringan lambat', 'jaringan putus',
  'koneksi putus', 'koneksi lambat', 'koneksi mati', 'sinyal ilang', 'sinyal hilang',
  'lampu merah', 'lampu onu merah', 'onu merah', 'onu mati', 'offline terus', 'disconnect terus',
  'kenapa internet', 'kenapa wifi', 'susah internet', 'susah wifi'
];

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deteksi apakah teks bebas mengandung keluhan gangguan jaringan (bahasa natural, tanpa command). */
function detectNetworkComplaint(text) {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  return NETWORK_COMPLAINT_PHRASES.some((p) => norm.includes(p));
}

/**
 * Coba cocokkan teks bebas (bahasa natural / typo) ke command pelanggan yang valid.
 * Dipanggil sebagai fallback setelah parseCommand() gagal menemukan match persis.
 */
function fuzzyMatchCommand(text) {
  const norm = normalizeForMatch(text);
  if (!norm) return null;

  // 1. Cocokkan frasa bahasa natural (mis. "tagihan saya berapa ya")
  for (const intent of NATURAL_LANGUAGE_INTENTS) {
    if (intent.phrases.some((p) => norm.includes(p))) {
      if (intent.cmd === 'gantissid' || intent.cmd === 'gantisandi') return null; // butuh argumen, jangan auto-trigger
      return { cmd: intent.cmd, rest: '', fuzzy: true };
    }
  }

  // 2. Cocokkan typo pada kata pertama (mis. "cektagian", "reeboot")
  const firstWord = norm.split(' ')[0];
  if (firstWord && firstWord.length >= 4) {
    let best = null;
    let bestDist = Infinity;
    for (const known of KNOWN_COMMAND_WORDS) {
      const dist = levenshtein(firstWord, known);
      if (dist < bestDist) { bestDist = dist; best = known; }
    }
    const threshold = firstWord.length <= 6 ? 1 : 2;
    if (best && bestDist <= threshold && ['menu', 'bantuan', 'help', 'cektagihan', 'info', 'cekstatus', 'cekonu', 'statusonu', 'cekterhubung', 'reboot', 'restartonu'].includes(best)) {
      if (best === 'menu' || best === 'bantuan' || best === 'help') return { cmd: 'menu', rest: '', fuzzy: true };
      if (['cekstatus', 'cekonu', 'statusonu'].includes(best)) return { cmd: 'info', rest: '', fuzzy: true };
      if (best === 'restartonu') return { cmd: 'reboot', rest: '', fuzzy: true };
      return { cmd: best, rest: '', fuzzy: true };
    }
  }

  return null;
}

function parseCommand(text, isAdmin) {
  const t = String(text || '').trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = t.slice(parts[0].length).trim();

  if (['menu', 'bantuan', 'help'].includes(cmd)) return { cmd: 'menu', rest: '' };

  if (isAdmin && ['admin', 'adminmenu', 'menuadmin'].includes(cmd)) return { cmd: 'adminmenu', rest: '' };

  if (isAdmin && ['listonu', 'listdevice', 'daftarperangkat'].includes(cmd)) {
    return { cmd: 'listonu', admin: true };
  }

  if (isAdmin && ['saldodigi', 'ceksaldodigi', 'digisaldo', 'ceksaldo.digi'].includes(cmd)) {
    return { cmd: 'digiflazz_balance', admin: true };
  }

  if (isAdmin && ['topup', 'topupagent', 'tfagent', 'transferagent', 'depositagent'].includes(cmd) && parts.length >= 3) {
    return { cmd: 'topupagent', admin: true, agentKey: parts[1], amount: parts[2], note: parts.slice(3).join(' ') };
  }

  // Admin Mikrotik
  if (isAdmin && cmd === 'mtactive') return { cmd: 'mtactive', admin: true };
  if (isAdmin && cmd === 'kickuser' && parts.length >= 2) return { cmd: 'kickuser', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'addpppoe' && parts.length >= 4) return { cmd: 'addpppoe', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'editpppoe' && parts.length >= 3) return { cmd: 'editpppoe', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'delpppoe' && parts.length >= 2) return { cmd: 'delpppoe', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'addhotspot' && parts.length >= 4) return { cmd: 'addhotspot', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'vcr' && parts.length >= 3) return { cmd: 'vcr', admin: true, args: parts.slice(1) };
  if (isAdmin && cmd === 'delhotspot' && parts.length >= 2) return { cmd: 'delhotspot', admin: true, args: parts.slice(1) };

  // Admin Billing & Pelanggan
  if (isAdmin && cmd === 'ringkasan') return { cmd: 'ringkasan', admin: true };
  if (isAdmin && cmd === 'lunas' && parts.length >= 2) return { cmd: 'lunas', admin: true, targetId: rest || parts.slice(1).join(' ') };
  if (isAdmin && cmd === 'generate' && parts.length >= 3) return { cmd: 'generate', admin: true, month: parts[1], year: parts[2] };
  if (isAdmin && cmd === 'isolir' && parts.length >= 2) return { cmd: 'isolir', admin: true, targetId: parts[1] };
  if (isAdmin && cmd === 'buka' && parts.length >= 2) return { cmd: 'buka', admin: true, targetId: parts[1] };

  if (isAdmin && ['info', 'cekstatus', 'cekonu', 'statusonu'].includes(cmd) && parts.length >= 2) {
    return { cmd: 'info', admin: true, targetTag: parts[1], rest: '' };
  }
  if (isAdmin && cmd === 'cekterhubung' && parts.length >= 2) {
    return { cmd: 'cekterhubung', admin: true, targetTag: parts[1] };
  }
  if (isAdmin && (cmd === 'reboot' || cmd === 'restartonu') && parts.length >= 2) {
    return { cmd: 'reboot', admin: true, targetTag: parts[1] };
  }
  if (isAdmin && cmd === 'gantissid' && parts.length >= 3) {
    return { cmd: 'gantissid', admin: true, targetTag: parts[1], rest: parts.slice(2).join(' ') };
  }
  if (isAdmin && cmd === 'gantisandi' && parts.length >= 3) {
    return { cmd: 'gantisandi', admin: true, targetTag: parts[1], rest: parts.slice(2).join(' ') };
  }

  if (['pulsa', 'belipulsa'].includes(cmd) && parts.length >= 3) {
    const sellPrice = parts.length >= 4 ? Number(String(parts[3]).replace(/[^\d]/g, '')) : 0;
    return { cmd: 'agent_pulsa', sku: parts[1], target: parts[2], sellPrice: Number.isFinite(sellPrice) ? sellPrice : 0 };
  }
  if (['cekpulsa', 'statuspulsa'].includes(cmd) && parts.length >= 2) {
    return { cmd: 'agent_pulsa_check', txId: parts[1] };
  }

  // Customer Commands
  if (cmd === 'cektagihan') return { cmd: 'cektagihan', rest: '' };
  if (['info', 'cekstatus', 'cekonu', 'statusonu'].includes(cmd)) return { cmd: 'info', rest: '' };
  if (cmd === 'cekterhubung') return { cmd: 'cekterhubung', rest: '' };
  if (cmd === 'gantissid') return { cmd: 'gantissid', rest };
  if (cmd === 'gantisandi') return { cmd: 'gantisandi', rest };
  if (cmd === 'daftar') return { cmd: 'daftar', rest };
  if (cmd === 'reboot' || cmd === 'restartonu') return { cmd: 'reboot', rest: '' };
  return null;
}

async function resolveTargetTagForAdmin(tagToken) {
  if (!tagToken) return null;

  // 1. Coba cari di database billing dulu (by name, pppoe, phone, etc)
  const cust = customerSvc.findCustomerByAny(tagToken);
  if (cust) return cust.genieacs_tag || cust.pppoe_username || cust.phone || tagToken;

  return tagToken;
}

function formatListOnu(devices) {
  const companyHeader = getSetting('company_header', 'ZenRadius');
  const footerInfo = getSetting('footer_info', 'ZenRadius - All Rights Reserved');

  const header = `📱 *DAFTAR ONU BER-TAG*
${'─'.repeat(30)}
📊 *${companyHeader}*
${'─'.repeat(30)}
`;
  const footer = `
${'─'.repeat(30)}
${footerInfo}`;

  if (!devices || devices.length === 0) {
    return header + `❌ Tidak ada perangkat dengan tag.` + footer;
  }

  const content = `📊 *${devices.length} perangkat ditemukan:*
`;
  const lines = devices.map((d, i) => {
    const num = String(i + 1).padStart(2, '0');
    const tags = Array.isArray(d._tags) ? d._tags.join(', ') : String(d._tags || '-');
    
    let pppoeUsername = '-';
    try {
      if (d.InternetGatewayDevice?.WANDevice) {
        for (const wanKey of Object.keys(d.InternetGatewayDevice.WANDevice)) {
          if (wanKey.startsWith('_')) continue;
          const wanDev = d.InternetGatewayDevice.WANDevice[wanKey];
          if (wanDev?.WANConnectionDevice) {
            for (const connKey of Object.keys(wanDev.WANConnectionDevice)) {
              if (connKey.startsWith('_')) continue;
              const connDev = wanDev.WANConnectionDevice[connKey];
              if (connDev?.WANPPPConnection) {
                for (const pppKey of Object.keys(connDev.WANPPPConnection)) {
                  if (pppKey.startsWith('_')) continue;
                  const pppConn = connDev.WANPPPConnection[pppKey];
                  if (pppConn?.Username?._value) {
                    pppoeUsername = pppConn.Username._value;
                    break;
                  }
                }
              }
              if (pppoeUsername !== '-') break;
            }
          }
          if (pppoeUsername !== '-') break;
        }
      }
      if (pppoeUsername === '-' && d.Device?.PPP?.Interface) {
        for (const pppKey of Object.keys(d.Device.PPP.Interface)) {
          if (pppKey.startsWith('_')) continue;
          const pppInt = d.Device.PPP.Interface[pppKey];
          if (pppInt?.Username?._value) {
            pppoeUsername = pppInt.Username._value;
            break;
          }
        }
      }
    } catch (_) {}

    const li = d._lastInform ? formatDateLocal(d._lastInform) : '-';
    return `${num}. 🏷️ *${tags}*
   � PPPoE: ${pppoeUsername}
   ⏱️ Last inform: ${li}`;
  }).join('\n\n');

  return header + content + lines + footer;
}

function splitWaChunks(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks;
}

/** Kirim notifikasi ke pelanggan saat admin mengubah SSID/Password */
async function notifyCustomer(sock, lidStore, tag, message) {
  logger.info(`[WA notifyCustomer] Memulai pengiriman untuk tag: "${tag}"`);
  try {
    const text = waAutoWrap(message);
    const normalizeDigitsTo62 = (raw) => {
      let digits = String(raw || '').replace(/\D/g, '');
      if (!digits) return '';
      if (digits.startsWith('0')) digits = '62' + digits.slice(1);
      else if (!digits.startsWith('62')) digits = '62' + digits;
      return digits;
    };

    // 1. Coba cari data pelanggan dari database dulu untuk mendapatkan nomor HP aslinya
    const cust = customerSvc.findCustomerByAny(tag);
    let phoneNumber = '';
    if (cust && cust.phone) {
      phoneNumber = normalizeDigitsTo62(cust.phone);
    }
    logger.info(`[WA notifyCustomer] Resolusi database tag "${tag}" -> Phone: "${phoneNumber}"`);
    
    // Jika tag itu sendiri adalah nomor HP, gunakan sebagai fallback
    if (!phoneNumber) {
      const parsedTag = normalizeDigitsTo62(tag);
      if (parsedTag.length >= 10) {
        phoneNumber = parsedTag;
      }
    }

    let targetJid = null;

    // 2. Jika ada nomor HP, tanyakan ke WhatsApp server untuk JID yang benar (LID atau PN JID)
    if (phoneNumber.length >= 10) {
      const directJid = `${phoneNumber}@s.whatsapp.net`;
      logger.info(`[WA notifyCustomer] Mengecek JID terdaftar untuk ${directJid} via onWhatsApp...`);
      try {
        const [waCheck] = await sock.onWhatsApp(directJid);
        if (waCheck && waCheck.exists) {
          targetJid = waCheck.lid || waCheck.jid || directJid;
          logger.info(`[WA notifyCustomer] JID terverifikasi dari WhatsApp server (menggunakan LID jika ada) untuk nomor ${phoneNumber}: ${targetJid}`);
        } else {
          logger.info(`[WA notifyCustomer] Nomor ${phoneNumber} tidak terdaftar menurut onWhatsApp`);
        }
      } catch (err) {
        logger.error(`[WA notifyCustomer] Gagal onWhatsApp check untuk nomor ${phoneNumber}: ${err.message}`);
      }
      
      // Jika onWhatsApp gagal/error, fallback ke directJid asli
      if (!targetJid) {
        logger.info(`[WA notifyCustomer] Menggunakan fallback JID langsung: ${directJid}`);
        targetJid = directJid;
      }
    }

    // 3. Fallback: Cari JID pelanggan berdasarkan tag di lidStore jika targetJid belum terisi
    if (!targetJid) {
      const customerJid = lidStore ? lidStore.getByTag(tag) : null;
      if (customerJid) {
        logger.info(`[WA notifyCustomer] Menemukan JID dari lidStore untuk tag "${tag}": ${customerJid}`);
        targetJid = customerJid;
      }
    }

    if (targetJid) {
      logger.info(`[WA notifyCustomer] Mengirim pesan ke JID target: ${targetJid}`);
      await sock.sendMessage(targetJid, { text });
      logger.info(`[WA notifyCustomer] Pesan berhasil dikirim ke JID target: ${targetJid}`);
      return true;
    }

    logger.warn(`[WA notifyCustomer] Tidak ada tujuan valid untuk mengirim notifikasi pelanggan tag: ${tag}`);
    return false;
  } catch (e) {
    logger.error('[WA notifyCustomer] Gagal mengirim notifikasi ke pelanggan: ' + (e.message || e));
    return false;
  }
}

function getMenuText() {
  const { companyHeader, footerInfo, sep } = waBrand();
  return `📱 *MENU PELANGGAN*
${sep}
🏢 *${companyHeader}*
${sep}

📋 *Perintah Tersedia:*

🧾 \`menu\` / \`bantuan\` — Tampilkan bantuan ini
📡 \`info\` / \`cekstatus\` — Status ONU Anda
💳 \`cektagihan\` — Lihat status tagihan
👥 \`cekterhubung\` — Daftar host terhubung
📶 \`gantissid\` _nama_ — Ubah nama WiFi
🔑 \`gantisandi\` _sandi_ — Ubah password
🔄 \`reboot\` — Restart ONU
🔗 \`daftar\` _tag/nomor_ — Bind nomor WA

🧠 *Chat Bebas (Natural):*
Anda juga bisa mengetik dengan bahasa sehari-hari, contoh:
_"tagihan saya berapa?"_, _"wifi saya mati"_, _"internet lambat"_, _"ganti password wifi"_ — bot akan otomatis memahami maksud Anda dan (untuk keluhan jaringan) langsung memberi diagnosa awal.

${sep}
${footerInfo ? footerInfo : '💡 *Contoh:* `cektagihan`'}`;
}

function getAdminMenuText() {
  const { companyHeader, footerInfo, sep } = waBrand();
  return `🛠️ *MENU ADMIN*
${sep}
🏢 *${companyHeader}*
${sep}

🏦 *Digiflazz:*
💳 \`saldodigi\` — Cek saldo deposit Digiflazz

👥 *Agent:*
💸 \`topup\` _nama/username/id/nohp nominal_ — Transfer saldo ke agent

📡 *MikroTik:*
🟢 \`mtactive\` — User active saat ini
✂️ \`kickuser\` _user_ — Putus session active
➕ \`addpppoe\` _user pass profile_
📝 \`editpppoe\` _user profile_
🗑️ \`delpppoe\` _user_
➕ \`addhotspot\` _user pass profile_
🎟️ \`vcr\` _kode profile_ — User=Pass + Comment
🗑️ \`delhotspot\` _user_

💰 *Billing:*
📊 \`ringkasan\` — Statistik billing
✅ \`lunas\` _ID_ — Tandai lunas ID tagihan
🧾 \`generate\` _bln thn_ — Generate tagihan

👥 *Pelanggan:*
⛔ \`isolir\` _ID_ — Suspend pelanggan
🟢 \`buka\` _ID_ — Aktifkan pelanggan

📱 *Device ONU:*
📋 \`listonu\` — Daftar semua ONU
📶 \`info\` / \`cekstatus\` _TAG_ — Status ONU
🔄 \`reboot\` _TAG_ — Restart ONU
📶 \`gantissid\` _TAG_ _namaSSID_ — Ubah SSID ONU
🔑 \`gantisandi\` _TAG_ _password_ — Ubah password ONU (min 8)

⚡ *Digiflazz (Admin):*
⚡ \`pulsa\` _SKU TARGET_ — Transaksi pulsa/produk
🔎 \`cekpulsa\` _TXID_ — Cek status transaksi

${sep}
${footerInfo ? footerInfo : '💡 _Tanpa TAG = perintah untuk device yang terikat ke WA Anda._'}`;
}

export const whatsappStatus = {
  connection: 'connecting',
  qr: null,
  user: null,
  lastUpdate: getCurrentDateInTimezone()
};

let currentSock = null;
let qrShownSinceStart = false;
let notifiedAdminForQr = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 120000;
const RECONNECT_MAX_ATTEMPTS = 10;

function getReconnectDelay(attempt) {
  const exp = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * 2000);
  return exp + jitter;
}

function loadWhatsappAdminSendList() {
  const list = getWhatsappAdminNumbers();
  const out = [];
  const seen = new Set();
  for (const n of list) {
    let digits = String(n).replace(/\D/g, '');
    if (!digits) continue;
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    if (digits.length < 8) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push(digits);
  }
  return out;
}

/**
 * Send monitoring alert to admin and technicians
 * @param {string} message - Alert message to send
 * @param {string} priority - Priority level: 'high', 'medium', 'low'
 */
export async function sendMonitoringAlert(message, priority = 'medium') {
  if (!currentSock || whatsappStatus.connection !== 'open') {
    logger.warn('[WhatsApp] Bot belum siap (koneksi belum terbuka), tidak dapat mengirim alert monitoring');
    return { success: false, message: 'Bot belum siap' };
  }

  try {
    const priorityIcon = priority === 'high' ? '🚨' : priority === 'medium' ? '⚠️' : 'ℹ️';
    const formattedMessage = `${priorityIcon} *MONITORING ALERT*\n\n${message}`;

    // Get admin numbers from settings
    const adminNumbers = getWhatsappAdminNumbers();

    // Get technician numbers from database (active technicians only)
    const techSvc = require('./techService');
    const technicians = techSvc.getAllTechnicians();
    const techNumbers = technicians
      .filter(tech => tech.is_active === 1 && tech.phone)
      .map(tech => {
        let phone = String(tech.phone || '').replace(/\D/g, '');
        // Convert 08xxx to 628xxx
        if (phone.startsWith('0')) {
          phone = '62' + phone.slice(1);
        }
        return phone;
      })
      .filter(Boolean);

    const toJid = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return '';
      if (s.includes('@')) return s;
      let digits = s.replace(/\D/g, '');
      if (!digits) return '';
      if (digits.startsWith('0')) digits = '62' + digits.slice(1);
      if (digits.length < 8) return '';
      return `${digits}@s.whatsapp.net`;
    };

    const adminJids = Array.from(new Set((adminNumbers || []).map(toJid).filter(Boolean)));
    const techJids = Array.from(new Set((techNumbers || []).map(toJid).filter(Boolean)));
    const recipients = Array.from(new Set([...adminJids, ...techJids]));

    if (recipients.length === 0) {
      logger.warn('[WhatsApp] Tidak ada nomor penerima alert monitoring yang dikonfigurasi');
      return { success: false, message: 'Tidak ada penerima yang dikonfigurasi' };
    }

    logger.info(`[WhatsApp] Mengirim alert monitoring ke ${recipients.length} penerima (${adminJids.length} admin, ${techJids.length} teknisi)`);

    const results = [];
    for (const jid of recipients) {
      try {
        await currentSock.sendMessage(jid, { text: formattedMessage });
        results.push({ jid, success: true });
        logger.info(`[WhatsApp] Alert monitoring terkirim ke ${jid}`);
      } catch (error) {
        results.push({ jid, success: false, error: error.message });
        logger.error(`[WhatsApp] Gagal mengirim alert ke ${jid}: ${error.message}`);
      }
    }

    const successCount = results.filter(r => r.success).length;
    return {
      success: successCount > 0,
      message: `Alert terkirim ke ${successCount}/${recipients.length} penerima (${adminJids.length} admin, ${techJids.length} teknisi)`,
      results
    };
  } catch (error) {
    logger.error(`[WhatsApp] Error mengirim monitoring alert: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export function parseSpintax(text) {
  if (!text) return '';
  return String(text).replace(/\{([^{}]+)\}/g, (match, choices) => {
    const arr = choices.split('|');
    return arr[Math.floor(Math.random() * arr.length)];
  });
}

export async function simulateHumanTyping(sock, jid, text = '') {
  if (!sock || !jid) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    const textLen = String(text || '').length;
    const typingDuration = Math.min(Math.max(textLen * 35, 1200), 4000);
    await new Promise(resolve => setTimeout(resolve, typingDuration));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (err) {
    // Non-critical, ignore presence errors
  }
}

export async function sendWA(to, text, options = {}) {
  if (!currentSock || whatsappStatus.connection !== 'open') {
    logger.warn('WhatsApp: Gagal kirim pesan, bot belum terhubung.');
    return false;
  }
  try {
    let digits = to.replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    let jid = to.includes('@') ? to : `${digits}@s.whatsapp.net`;
    logger.info(`[WA sendWA] Mengirim ke: ${to} -> JID Awal: ${jid}`);
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const waCheck = await currentSock.onWhatsApp(jid);
        if (waCheck && waCheck.length > 0 && waCheck[0].exists) {
          jid = waCheck[0].jid || waCheck[0].lid || jid;
        }
      } catch (err) {
        logger.error(`[WA sendWA] Gagal check onWhatsApp untuk ${jid}: ${err.message}`);
      }
    }

    let finalText = text;
    if (options.spintax !== false && (text.includes('{') && text.includes('}'))) {
      finalText = parseSpintax(text);
    }

    if (options.simulateTyping !== false) {
      await simulateHumanTyping(currentSock, jid, finalText);
    }

    logger.info(`[WA sendWA] Mengeksekusi sendMessage ke JID: ${jid}`);
    const result = await currentSock.sendMessage(jid, { text: finalText });
    if (result && result.key && result.message) {
      cacheSentMessage(result.key, result.message);
    }
    logger.info(`[WA sendWA] sendMessage selesai! Result JID: ${result?.key?.remoteJid || 'null'}, ID: ${result?.key?.id || 'null'}`);
    return true;
  } catch (e) {
    logger.error('[WA sendWA] Gagal kirim WA:', e.message);
    return false;
  }
}

export async function sendWAImage(to, imageBuffer, caption = '', options = {}) {
  if (!currentSock || whatsappStatus.connection !== 'open') {
    logger.warn('WhatsApp: Gagal kirim pesan, bot belum terhubung.');
    return false;
  }
  try {
    let digits = String(to || '').replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    let jid = String(to || '').includes('@') ? String(to) : `${digits}@s.whatsapp.net`;
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const [waCheck] = await currentSock.onWhatsApp(jid);
        if (waCheck && waCheck.exists && waCheck.jid) {
          jid = waCheck.jid;
        }
      } catch (err) {
        logger.debug(`[WA] sendWAImage JID resolution failed for ${jid}: ${err.message}`);
      }
    }
    const img = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer || []);
    if (!img.length) return false;

    let finalCaption = caption;
    if (options.spintax !== false && (caption.includes('{') && caption.includes('}'))) {
      finalCaption = parseSpintax(caption);
    }

    if (options.simulateTyping !== false) {
      await simulateHumanTyping(currentSock, jid, finalCaption);
    }

    await currentSock.sendMessage(jid, { image: img, caption: String(finalCaption || '') });
    return true;
  } catch (e) {
    logger.error('Gagal kirim WA image:', e.message);
    return false;
  }
}

export async function sendWADocument(to, documentBuffer, filename = 'Invoice.pdf', caption = '', mimetype = 'application/pdf', options = {}) {
  if (!currentSock || whatsappStatus.connection !== 'open') {
    logger.warn('WhatsApp: Gagal kirim dokumen, bot belum terhubung.');
    return false;
  }
  try {
    let digits = String(to || '').replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }
    let jid = String(to || '').includes('@') ? String(to) : `${digits}@s.whatsapp.net`;
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const [waCheck] = await currentSock.onWhatsApp(jid);
        if (waCheck && waCheck.exists && waCheck.jid) {
          jid = waCheck.jid;
        }
      } catch (err) {
        logger.debug(`[WA] sendWADocument JID resolution failed for ${jid}: ${err.message}`);
      }
    }
    const doc = Buffer.isBuffer(documentBuffer) ? documentBuffer : Buffer.from(documentBuffer || []);
    if (!doc.length) return false;

    let finalCaption = caption;
    if (options.spintax !== false && (caption.includes('{') && caption.includes('}'))) {
      finalCaption = parseSpintax(caption);
    }

    if (options.simulateTyping !== false) {
      await simulateHumanTyping(currentSock, jid, finalCaption);
    }

    await currentSock.sendMessage(jid, {
      document: doc,
      mimetype: mimetype || 'application/pdf',
      fileName: filename || 'Document.pdf',
      caption: String(finalCaption || '')
    });
    return true;
  } catch (e) {
    logger.error('Gagal kirim WA document:', e.message);
    return false;
  }
}

export async function stopWhatsAppBot(reason = 'dinonaktifkan dari pengaturan') {
  logger.info(`WhatsApp: Menghentikan bot (${reason})...`);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (currentSock) {
    try {
      currentSock.ev.removeAllListeners();
      currentSock.end();
    } catch (e) {
      logger.error('WhatsApp: Gagal menghentikan socket:', e.message);
    }
    currentSock = null;
  }
  whatsappStatus.connection = 'disabled';
  whatsappStatus.qr = null;
  whatsappStatus.user = null;
  whatsappStatus.lastUpdate = getCurrentDateInTimezone();
}

export async function restartWhatsAppBot() {
  logger.info('WhatsApp: Memulai ulang bot...');
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (currentSock) {
    try {
      currentSock.end();
    } catch (e) {
      logger.error('WhatsApp: Gagal menghentikan socket lama:', e.message);
    }
  }
  // Beri jeda sedikit agar socket lama benar-benar tertutup
  setTimeout(() => {
    startWhatsAppBot();
  }, 1000);
}

export async function startWhatsAppBot() {
  if (!getSetting('whatsapp_enabled', false)) {
    logger.warn('WhatsApp: whatsapp_enabled=false, bot tidak dijalankan. Aktifkan di Pengaturan > WhatsApp.');
    whatsappStatus.connection = 'disabled';
    whatsappStatus.qr = null;
    return;
  }
  whatsappStatus.connection = 'connecting';
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (currentSock) {
    try {
      logger.info('WhatsApp: Menutup koneksi socket lama yang masih aktif sebelum reconnect...');
      currentSock.ev.removeAllListeners();
      currentSock.end();
    } catch (e) {
      logger.error('WhatsApp: Gagal menutup socket lama:', e.message);
    }
    currentSock = null;
  }

  const authFolder = path.resolve(projectRoot, getSetting('whatsapp_auth_folder', 'auth_info_baileys'));
  const lidMapPath = path.resolve(projectRoot, getSetting('whatsapp_lid_map_file', 'data/wa-lid-map.json'));
  const lidStore = new WaLidStore(lidMapPath);

  // PHASE 12: Baileys' useMultiFileAuthState() never creates the auth folder
  // itself — on a fresh non-Docker install (folder not pre-created), the
  // first session write would fail. Docker images already pre-create this
  // directory; this is a safe no-op there and only matters for bare-metal/PM2
  // fresh installs.
  try {
    fs.mkdirSync(authFolder, { recursive: true });
    fs.mkdirSync(path.dirname(lidMapPath), { recursive: true });
  } catch (e) {
    logger.error(`WhatsApp: Gagal membuat direktori auth/data: ${e.message}`);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  let version = [2, 3000, 1017531287]; // Fallback version
  try {
    const latest = await fetchLatestBaileysVersion();
    if (latest && latest.version) {
      version = latest.version;
    }
  } catch (err) {
    logger.warn(`WhatsApp: Gagal mengambil versi terbaru Baileys: ${err.message}. Menggunakan fallback.`);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    msgRetryCounterCache,
    getMessage: async (key) => {
      if (key && key.id) {
        const storeKey = `${key.remoteJid || ''}:${key.id}`;
        const cached = sentMessageMap.get(storeKey);
        if (cached) return cached;
      }
      return { conversation: '' };
    },
    keepAliveIntervalMs: 45000,
    connectTimeoutMs: 90000,
    defaultQueryTimeoutMs: 90000,
    logger: pino({ level: 'silent' })
  });

  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    whatsappStatus.lastUpdate = getCurrentDateInTimezone();

    if (qr) {
      whatsappStatus.qr = qr;
      whatsappStatus.connection = 'qr';
      qrShownSinceStart = true;
      notifiedAdminForQr = false;
      logger.info(`[WA] QR Code Baru Dihasilkan: ${qr.slice(0, 20)}...`);
      qrcode.generate(qr, { small: true });
    }

    if (connection) {
      logger.info(`[WA] Connection Update: ${connection}`);
    }

    if (connection === 'close') {
      whatsappStatus.qr = null;
      whatsappStatus.user = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = code === DisconnectReason.loggedOut;
      const isRestartRequired = code === DisconnectReason.restartRequired;
      const shouldReconnect = !isLoggedOut;
      whatsappStatus.connection = isLoggedOut ? 'loggedOut' : 'connecting';

      if (isLoggedOut) {
        reconnectAttempts = 0;
        logger.warn(`WhatsApp terputus (kode ${code}). Sesi logout — membersihkan kredensial lama dan menyiapkan QR baru...`);
        // Bersihkan ISI folder auth (bukan foldernya — di Docker ini bind-mount,
        // rmdir mount point akan gagal EBUSY). Lalu restart agar QR baru muncul.
        try {
          for (const entry of fs.readdirSync(authFolder)) {
            fs.rmSync(path.join(authFolder, entry), { recursive: true, force: true });
          }
          logger.info('[WA] Kredensial sesi lama dihapus otomatis.');
        } catch (e) {
          logger.error(`[WA] Gagal membersihkan sesi lama: ${e.message}`);
        }
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startWhatsAppBot();
          }, 3000);
        }
      } else if (isRestartRequired) {
        reconnectAttempts = 0;
        logger.warn(`WhatsApp restart required (kode ${code}) — reconnect segera...`);
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startWhatsAppBot();
          }, 2000);
        }
      } else {
        if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
          logger.error(`WhatsApp: ${reconnectAttempts} percobaan reconnect gagal berturut-turut. Berhenti auto-retry. Silakan restart manual di /admin/whatsapp atau scan QR lagi.`);
          whatsappStatus.connection = 'failed';
          whatsappStatus.lastUpdate = getCurrentDateInTimezone();
          // Kirim alert ke admin jika ada nomor notif dikonfigurasi (best effort)
          try {
            const list = loadWhatsappAdminSendList();
            if (list.length === 0) logger.warn('[WA] Tidak ada nomor notif untuk alert gagal konek.');
          } catch {}
          reconnectAttempts = 0;
        } else {
          const delay = getReconnectDelay(reconnectAttempts);
          reconnectAttempts++;
          logger.warn(`WhatsApp terputus (kode ${code}). Reconnect #${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} dalam ${Math.round(delay/1000)} detik...`);
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              startWhatsAppBot();
            }, delay);
          }
        }
      }
    } else if (connection === 'open') {
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      whatsappStatus.qr = null;
      whatsappStatus.connection = 'open';
      whatsappStatus.user = sock.user;
      logger.info('WhatsApp bot terhubung. Akun Bot JID: ' + (sock.user?.id || 'unknown') + ', Name: ' + (sock.user?.name || 'unknown'));

      // Pre-resolve admin LIDs
      (async () => {
        try {
          const adminList = getWhatsappAdminNumbers();
          for (const n of adminList) {
            const digits = String(n).replace(/\D/g, '');
            if (digits.length >= 8) {
              const formatted = digits.startsWith('0') ? '62' + digits.slice(1) : digits.startsWith('62') ? digits : '62' + digits;
              const jid = `${formatted}@s.whatsapp.net`;
              const waCheck = await sock.onWhatsApp(jid).catch(() => []);
              if (waCheck && waCheck.length > 0 && waCheck[0].exists && waCheck[0].lid) {
                const lidJid = waCheck[0].lid;
                const lidUser = lidJid.split('@')[0];
                lidStore.set(lidJid, formatted);
                lidStore.set(lidUser, formatted);
                logger.info(`[WA Admin Pre-resolve] Nomor admin ${formatted} terpetakan ke LID: ${lidJid}`);
              }
            }
          }
        } catch (e) {
          logger.warn(`[WA Admin Pre-resolve] Pre-resolve error: ${e.message}`);
        }
      })();

      if (qrShownSinceStart && !notifiedAdminForQr) {
        notifiedAdminForQr = true;
        const toList = loadWhatsappAdminSendList();
        if (toList.length > 0) {
          const wid = sock.user?.id ? String(sock.user.id).split(':')[0] : '-';
          const body =
            `✅ QR berhasil dipindai dan bot sudah aktif.\n\n` +
            `Nomor Bot: ${wid}\n` +
            `Waktu: ${getNowLocal()}\n\n` +
            `Silakan gunakan menu Admin untuk fitur billing, notifikasi, dan broadcast.\n\n` +
            `🙏 Jika aplikasi ini bermanfaat dan Anda ingin mendukung pengembangan, Anda dapat berdonasi secara sukarela ke nomor: 6285178008881.\n` +
            `Terima kasih atas dukungannya.`;
          const msg = waWrap('🤖 *WHATSAPP BOT AKTIF*', body);
          for (const digits of toList) {
            const jid = `${digits}@s.whatsapp.net`;
            sock.sendMessage(jid, { text: msg }).catch(() => { });
          }
        }
        qrShownSinceStart = false;
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        const selfPn = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
        const selfLid = sock.user && sock.user.lid ? sock.user.lid.split('@')[0] : null;
        const remoteUser = m.key.remoteJid ? m.key.remoteJid.split('@')[0] : null;
        const isSelf = m.key.fromMe && (remoteUser === selfPn || (selfLid && remoteUser === selfLid));
        if (m.key.fromMe && !isSelf) continue;
        const text = getMessageText(m);
        if (!text) continue;

        const remote = m.key.remoteJid;
        if (!remote || remote.endsWith('@g.us')) continue;

        const reply = async (msg) => {
          logger.info(`[WA reply] Menyiapkan balasan ke ${remote}: "${msg.substring(0, 60)}..."`);
          try {
            const targetJid = (m.key.senderPn && m.key.senderPn.endsWith('@s.whatsapp.net')) 
              ? m.key.senderPn 
              : remote;

            logger.info(`[WA reply] Mengirim balasan ke JID target: ${targetJid}`);
            if (targetJid.endsWith('@lid')) {
              await sock.sendMessage(targetJid, { text: waAutoWrap(msg) });
            } else {
              await sock.sendMessage(targetJid, { text: waAutoWrap(msg) }, { quoted: m });
            }
            logger.info(`[WA reply] Balasan berhasil dikirim ke JID target: ${targetJid}`);
          } catch (sendErr) {
            logger.error('[WA reply] Gagal mengirim balasan: ' + sendErr.message);
          }
        };

        logger.info(`[WA] Pesan masuk dari ${remote}: "${text}"`);
        logger.info(`[WA] Full message object: ${JSON.stringify(m)}`);
        const adminSet = loadWhatsappAdminSet(lidStore);
        const isAdmin = isWhatsappAdminKey(m.key, adminSet, sock, lidStore);
        logger.info(`[WA] Sender details: JID=${remote}, isAdmin=${isAdmin}, adminSet=${JSON.stringify([...adminSet])}`);
        let parsed = parseCommand(text, isAdmin);
        const phone = getPhoneFromKey(m.key);

        // Multi-turn conversation state: jika sedang menunggu input lanjutan, proses sebelum command parser
        if (!isAdmin && phone) {
          const state = getConversationState(phone);
          if (state) {
            const stateAction = state.action;
            if (stateAction === 'await_ssid') {
              const newSSID = String(text || '').trim();
              if (newSSID) {
                clearConversationState(phone);
                const ok = await customerDevice.updateSSID(state.data.deviceKey, newSSID);
                await reply(ok
                  ? `✅ Nama WiFi berhasil diubah menjadi:\n\n📶 *${newSSID}*`
                  : '❌ Gagal mengubah nama WiFi. Coba lagi atau hubungi admin.');
                continue;
              }
            } else if (stateAction === 'await_password') {
              const newPass = String(text || '').trim();
              if (newPass) {
                if (newPass.length < 8) {
                  await reply('⚠️ Password minimal 8 karakter. Silakan kirim password yang lebih panjang.');
                  continue;
                }
                clearConversationState(phone);
                const ok = await customerDevice.updatePassword(state.data.deviceKey, newPass);
                await reply(ok
                  ? `✅ Password WiFi berhasil diubah menjadi:\n\n🔐 *${newPass}*`
                  : '❌ Gagal mengubah password WiFi.');
                continue;
              }
            }
          }
        }

        // Fallback bahasa natural/typo untuk pelanggan (non-admin, tanpa command persis)
        if (!parsed && !isAdmin) {
          parsed = fuzzyMatchCommand(text);
          if (parsed) {
            logger.info(`[WA] Fuzzy/NLU match: "${text}" -> ${parsed.cmd}`);
          }
        }

        // Respon simpatik untuk ucapan terima kasih / oke
        if (!parsed && !isAdmin) {
          const courtesy = detectCourtesy(text);
          if (courtesy === 'thanks') {
            await reply('😊 *Sama-sama!* Senang bisa membantu. Jika ada kebutuhan lain, ketik saja `menu`.');
            continue;
          }
          if (courtesy === 'ok') {
            await reply('👍 *Oke!* Jika butuh bantuan lain nanti, silakan kirim `menu` kapan saja.');
            continue;
          }
        }

        logger.info(`[WA] Parsed command: ${JSON.stringify(parsed)}`);

        // Auto-diagnosa gangguan jaringan saat pelanggan chat bebas mengeluh internet/wifi bermasalah
        if (!parsed && !isAdmin && detectNetworkComplaint(text)) {
          try {
            const ctxDiag = await resolveCustomerContext(m.key, lidStore);
            if (!ctxDiag) {
              await reply(
                '🔧 *DETEKSI KELUHAN GANGGUAN*\n\n' +
                'Sepertinya Anda melaporkan gangguan internet, namun nomor Anda belum dikenali sistem.\n\n' +
                'Kirim sekali:\n`daftar NOMORATAUTAG`\n(sama persis dengan tag di GenieACS), lalu coba lagi.'
              );
              continue;
            }

            const data = await customerDevice.getCustomerDeviceData(ctxDiag.deviceKey);
            const rx = data && data.rxPower !== '-' ? parseFloat(data.rxPower) : null;
            const isOffline = !data || data.status === 'Offline' || data.status === 'Tidak ditemukan';
            const isWeakSignal = rx !== null && !isNaN(rx) && rx < -27;

            const pppoeUptime = data?.pppoeUptime || '-';
            const totalUsers = data?.totalAssociations || '0';

            let diagnosis = '';
            let severity = 'low';
            if (isOffline) {
              diagnosis = '🔴 Perangkat *OFFLINE* — modem/ONU tidak terhubung ke sistem. Kemungkinan mati listrik, kabel fiber lepas, atau gangguan jaringan di area Anda.';
              severity = 'high';
            } else if (isWeakSignal) {
              diagnosis = `🟡 Perangkat online namun *redaman sinyal optik lemah* (${data.rxPower} dBm). Bisa menyebabkan internet lambat/putus-putus. Kemungkinan kabel fiber kotor, tertekuk, atau konektor longgar.`;
              severity = 'medium';
            } else if (String(pppoeUptime) === '-' || String(pppoeUptime) === '0') {
              diagnosis = '🟡 Perangkat ONU online namun sesi PPPoE belum terhubung. Kemungkinan username/password PPPoE bermasalah atau belum diaktifkan.';
              severity = 'medium';
            } else {
              diagnosis = '🟢 Perangkat terdeteksi *online* dengan sinyal normal. Kendala mungkin dari perangkat (HP/laptop) Anda atau beban jaringan sementara.';
              severity = 'low';
            }

            let body =
              `🔧 *AUTO-DIAGNOSA GANGGUAN*\n\n` +
              `${diagnosis}\n\n` +
              `📡 *Status:* ${data ? data.status : '-'}\n` +
              `📶 *RX Power:* ${data ? data.rxPower : '-'} dBm\n` +
              `⏳ *PPPoE Uptime:* ${pppoeUptime}\n` +
              `📱 *User WiFi:* ${totalUsers}\n\n`;

            if (severity === 'low') {
              body += '💡 *Saran:* Coba restart WiFi Anda dengan ketik `reboot`, atau restart HP/laptop Anda terlebih dahulu. Jika masih bermasalah, silakan hubungi teknisi kami.';
            } else {
              body += '📨 Laporan ini otomatis diteruskan ke tim teknisi kami. Mohon ditunggu, atau ketik `reboot` untuk mencoba restart ONU dari jarak jauh.';
            }

            await reply(body);

            if (severity !== 'low') {
              try {
                const custInfo = customerSvc.findCustomerByAny(ctxDiag.billingKey || ctxDiag.deviceKey);
                const custName = custInfo ? custInfo.name : (ctxDiag.deviceKey || '-');
                const alertBody =
                  `👤 *Pelanggan:* ${custName}\n` +
                  `📍 *Tag:* ${ctxDiag.deviceKey}\n` +
                  `💬 *Keluhan:* "${text}"\n\n` +
                  `${diagnosis}\n\n` +
                  `📡 Status: ${data ? data.status : '-'}\n` +
                  `📶 RX Power: ${data ? data.rxPower : '-'} dBm`;

                await sendMonitoringAlert(alertBody, severity === 'high' ? 'high' : 'medium');

                const groupJid = getSetting('whatsapp_tech_group_jid', '');
                if (groupJid && currentSock && whatsappStatus.connection === 'open') {
                  try {
                    await currentSock.sendMessage(groupJid, { text: `🚨 *ESKALASI GANGGUAN PELANGGAN*\n\n${alertBody}` });
                  } catch (_) { /* ignore group send error */ }
                }
              } catch (e) { /* ignore alert errors */ }
            }
          } catch (e) {
            logger.error('[WA auto-diagnosa] Gagal: ' + (e.message || e));
          }
          continue;
        }

        if (!parsed && !isAdmin) {
          const aiEnabled = getSetting('gemini_enabled', false) && getSetting('gemini_api_key', '');
          if (aiEnabled) {
            try {
              const ctxAi = await resolveCustomerContext(m.key, lidStore);
              const systemPrompt = buildGeminiSystemPrompt(ctxAi, false);
              const finalText = await callGeminiAI(systemPrompt, text, ctxAi, sock, lidStore);
              logger.info(`[WA AI] Final response: ${finalText ? finalText.substring(0, 120) : '(empty)'}`);

              if (finalText) {
                await reply(finalText);
                continue;
              }
            } catch (e) {
              logger.error('[WA AI] Error: ' + (e.message || e));
            }
          }

          const suggestion = suggestClosestCommand(text, isAdmin);
          let fallback =
            '🤖 *Maaf, saya belum mengerti maksud Anda.*\n\n' +
            'Ketik `menu` untuk melihat daftar perintah, atau coba chat bebas seperti:\n' +
            '_"tagihan saya berapa?"_\n' +
            '_"wifi saya mati"_\n' +
            '_"status internet saya"_\n' +
            '_"ganti password wifi"_';
          if (suggestion) {
            fallback =
              `🤖 *Maksud Anda \`${suggestion}\`?*\n\n` +
              `Ketik \`${suggestion}\` untuk menjalankan perintah tersebut, atau ketik \`menu\` untuk melihat semua perintah.`;
          }
          await reply(fallback);
          continue;
        }

        if (!parsed) continue;

        // Rate Limiting Check
        const phoneRate = getPhoneFromKey(m.key);
        if (phoneRate) {
          // Cek command cooldown (2 detik)
          const cooldownCheck = checkCommandCooldown(phoneRate);
          if (!cooldownCheck.allowed) {
            await reply(`⏳ Mohon tunggu *${cooldownCheck.waitTime} detik* sebelum mengirim perintah lagi.`);
            logger.warn(`[WhatsApp Bot] Rate limit cooldown triggered for ${phoneRate}`);
            continue;
          }

          // Cek rate limit per menit (10 perintah)
          const rateLimitCheck = checkRateLimit(phoneRate);
          if (!rateLimitCheck.allowed) {
            await reply(`⚠️ Anda telah mencapai batas perintah. Tunggu *${rateLimitCheck.waitTime} detik* sebelum mencoba lagi.`);
            logger.warn(`[WhatsApp Bot] Rate limit exceeded for ${phoneRate}`);
            continue;
          }

          // Log rate limit info
          if (rateLimitCheck.remaining <= 3) {
            logger.info(`[WhatsApp Bot] Rate limit warning for ${phoneRate}: ${rateLimitCheck.remaining} commands remaining`);
          }
        }

        if (parsed.cmd === 'menu') {
          let body = getMenuText();
          if (isAdmin) body += '\n\n_Anda admin — ketik `admin` untuk perintah kelola semua tag._';
          const phone = getPhoneFromKey(m.key);
          const agent = phone ? agentSvc.getAgentByPhone(phone) : null;
          if (agent) {
            body +=
              '\n\n📱 *MENU AGENT*\n' +
              '⚡ `pulsa SKU TARGET` — Beli pulsa/produk Digiflazz\n' +
              '🔎 `cekpulsa TXID` — Cek status transaksi pulsa';
          }
          // Jika hasil fuzzy match, beri prefix ramah agar user tahu bot memahami bahasa bebasnya.
          if (parsed.fuzzy) {
            body = `🧠 *Maksud Anda menu bantuan?*\n\n${body}`;
          }
          await reply(body);
          continue;
        }

        if (parsed.cmd === 'terimakasih') {
          await reply('😊 *Sama-sama!* Senang bisa membantu. Jika ada kebutuhan lain, ketik saja `menu`.');
          continue;
        }

        if (parsed.cmd === 'oke') {
          await reply('👍 *Oke!* Jika butuh bantuan lain nanti, silakan kirim `menu` kapan saja.');
          continue;
        }

        if (parsed.cmd === 'adminmenu') {
          if (!isAdmin) {
            await reply('❌ Perintah ini khusus nomor admin (pengaturan whatsapp_admin_numbers).');
            continue;
          }
          await reply(getAdminMenuText());
          continue;
        }

        if (parsed.cmd === 'listonu' && parsed.admin) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          let res = await customerDevice.listDevicesWithTags(300);
          if (!res.ok || !res.devices || res.devices.length === 0) {
            res = await customerDevice.listAllDevices(300);
          }
          if (!res.ok) {
            await reply('❌ ' + (res.message || 'Gagal mengambil daftar.'));
            continue;
          }
          const body = formatListOnu(res.devices || []);
          const chunks = splitWaChunks(body);
          for (const ch of chunks) {
            await reply(ch);
          }
          continue;
        }

        // Admin MikroTik Logic
        if (parsed.admin && parsed.cmd === 'mtactive') {
          try {
            const pppoe = await mikrotikSvc.getPppoeActive();
            const hotspot = await mikrotikSvc.getHotspotActive();
            await reply(formatActiveMikrotik(pppoe, hotspot));
          } catch (e) {
            await reply('❌ Gagal mengambil data aktif: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'kickuser') {
          try {
            const [user] = parsed.args;
            const pk = await mikrotikSvc.kickPppoeUser(user);
            const hk = await mikrotikSvc.kickHotspotUser(user);
            if (pk || hk) await reply(`✅ Session user *${user}* berhasil diputus.`);
            else await reply(`❌ User *${user}* tidak ditemukan di session aktif.`);
          } catch (e) {
            await reply('❌ Gagal kick user: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'addpppoe') {
          try {
            const [user, pass, profile] = parsed.args;
            await mikrotikSvc.addPppoeSecret({ name: user, password: pass, profile, service: 'pppoe' });
            await reply(`✅ PPPoE Secret *${user}* berhasil ditambahkan.`);
          } catch (e) {
            await reply('❌ Gagal tambah PPPoE: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'editpppoe') {
          try {
            const [user, profile] = parsed.args;
            await mikrotikSvc.setPppoeProfile(user, profile);
            await reply(`✅ Profile PPPoE *${user}* berhasil diubah ke *${profile}* dan session aktif telah diputus.`);
          } catch (e) {
            await reply('❌ Gagal edit PPPoE: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'delpppoe') {
          try {
            const [user] = parsed.args;
            const secrets = await mikrotikSvc.getPppoeSecrets();
            const found = secrets.find(s => s.name === user);
            if (!found) return await reply(`❌ User *${user}* tidak ditemukan.`);
            await mikrotikSvc.deletePppoeSecret(found['.id'] || found.id);
            await mikrotikSvc.kickPppoeUser(user);
            await reply(`✅ PPPoE Secret *${user}* berhasil dihapus dan session aktif diputus.`);
          } catch (e) {
            await reply('❌ Gagal hapus PPPoE: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'addhotspot') {
          try {
            const [user, pass, profile] = parsed.args;
            await mikrotikSvc.addHotspotUser({ name: user, password: pass, profile });
            await reply(`✅ Hotspot User *${user}* berhasil ditambahkan.`);
          } catch (e) {
            await reply('❌ Gagal tambah Hotspot: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'vcr') {
          try {
            const [code, profile] = parsed.args;
            const now = getCurrentDateInTimezone();
            const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
            const comment = `vc ${code} ${dateStr}`;

            await mikrotikSvc.addHotspotUser({
              name: code,
              password: code,
              profile: profile,
              comment: comment
            });

            await reply(`✅ Voucher Hotspot *${code}* berhasil dibuat.\n\n👤 User: *${code}*\n🔑 Pass: *${code}*\n🏷️ Profile: *${profile}*\n📝 Comment: *${comment}*`);
          } catch (e) {
            await reply('❌ Gagal buat voucher: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'delhotspot') {
          try {
            const [user] = parsed.args;
            const users = await mikrotikSvc.getHotspotUsers();
            const found = users.find(u => u.name === user);
            if (!found) return await reply(`❌ User Hotspot *${user}* tidak ditemukan.`);
            await mikrotikSvc.deleteHotspotUser(found['.id'] || found.id);
            await mikrotikSvc.kickHotspotUser(user);
            await reply(`✅ Hotspot User *${user}* berhasil dihapus dan session aktif diputus.`);
          } catch (e) {
            await reply('❌ Gagal hapus Hotspot: ' + e.message);
          }
          continue;
        }

        // Admin Billing Logic
        if (parsed.admin && parsed.cmd === 'ringkasan') {
          const stats = billingSvc.getDashboardStats();
          await reply(formatBillingSummary(stats));
          continue;
        }

        if (parsed.admin && parsed.cmd === 'lunas') {
          logger.info(`[WA lunas] Memulai pemrosesan lunas untuk target: "${parsed.targetId}"`);
          try {
            const keyRaw = String(parsed.targetId || '').trim();
            if (!keyRaw) {
              logger.warn(`[WA lunas] Target kosong!`);
              return await reply('❌ Format: `lunas IDTAGIHAN` atau `lunas nama/nohp/pppoe/tag`');
            }

            let targetInvId = null;
            let targetInv = null;
            const isNumeric = /^\d+$/.test(keyRaw);
            if (isNumeric) {
              targetInvId = Number(keyRaw);
              targetInv = billingSvc.getInvoiceById(targetInvId);
              logger.info(`[WA lunas] Pencarian numerik ID Invoice: ${targetInvId} -> Found: ${!!targetInv}`);
            }

            // If not found by ID, try find customer and their oldest unpaid invoice
            if (!targetInv) {
              let cust =
                (isNumeric ? customerSvc.getCustomerById(Number(keyRaw)) : null) ||
                customerSvc.findCustomerByAny(keyRaw);
              logger.info(`[WA lunas] Pencarian customer untuk key: "${keyRaw}" -> Found: ${cust ? cust.name + " (ID:" + cust.id + ")" : 'null'}`);

              if (!cust) {
                const candidates = customerSvc.getAllCustomers(keyRaw) || [];
                const unique = Array.from(new Map(candidates.map(c => [c.id, c])).values());
                logger.info(`[WA lunas] Ditemukan ${unique.length} kandidat unik`);
                if (unique.length === 1) {
                  cust = customerSvc.getCustomerById(unique[0].id);
                  logger.info(`[WA lunas] Menggunakan kandidat tunggal: ${cust.name}`);
                } else if (unique.length > 1) {
                  const top = unique.slice(0, 5).map(c =>
                    `- ID:${c.id} • ${c.name || '-'} • ${c.phone || '-'} • PPPoE:${c.pppoe_username || '-'}`
                  ).join('\n');
                  return await reply(`⚠️ Nama/ID tidak spesifik. Ditemukan ${unique.length} pelanggan:\n\n${top}\n\nKirim ulang: \`lunas IDPELANGGAN\` atau \`lunas NOHP/PPPOE/TAG\``);
                }
              }

              if (cust) {
                const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
                logger.info(`[WA lunas] Tagihan belum dibayar untuk customer ${cust.name}: ${unpaid ? unpaid.length : 0}`);
                if (unpaid && unpaid.length > 0) {
                  targetInv = unpaid[0];
                  targetInvId = targetInv.id;
                } else {
                  return await reply(`✅ Pelanggan *${cust.name}* tidak memiliki tagihan menunggak.`);
                }
              }
            }

            if (!targetInv) {
              logger.warn(`[WA lunas] Invoice/Customer tidak ditemukan untuk: "${keyRaw}"`);
              return await reply(`❌ Tagihan atau Pelanggan *${keyRaw}* tidak ditemukan.`);
            }
            if (targetInvId != null) {
              const enriched = billingSvc.getInvoiceById(targetInvId);
              if (enriched) targetInv = enriched;
            }
            if (targetInv && targetInv.status === 'paid') {
              logger.info(`[WA lunas] Invoice #${targetInv.id} sudah paid`);
              return await reply(`✅ Invoice *#${targetInv.id}* sudah berstatus LUNAS.`);
            }

            logger.info(`[WA lunas] Menandai lunas invoice #${targetInvId}...`);
            billingSvc.markAsPaid(targetInvId, 'WA Bot Admin', 'Paid via WhatsApp Command');

            const customer = customerSvc.getCustomerById(targetInv.customer_id);
            const formatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
            const customerName = String(targetInv.customer_name || customer?.name || targetInv.customer_name || '-');
            const notifyTag = customer?.genieacs_tag || customer?.pppoe_username || customer?.phone || targetInv.customer_phone || targetInv.genieacs_tag || '';
            logger.info(`[WA lunas] Detail: customerName="${customerName}", notifyTag="${notifyTag}", status="${customer?.status}"`);

            if (customer && customer.status === 'suspended') {
              const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === targetInv.customer_id);
              const unpaidCount = freshCustomer && Number.isFinite(Number(freshCustomer.unpaid_count)) ? Number(freshCustomer.unpaid_count) : 1;
              logger.info(`[WA lunas] Customer status suspended, sisa unpaidCount: ${unpaidCount}`);
              if (unpaidCount === 0) {
                logger.info(`[WA lunas] Mengaktifkan customer ID ${targetInv.customer_id}...`);
                await customerSvc.activateCustomer(targetInv.customer_id);
                logger.info(`[WA lunas] Customer berhasil diaktifkan. Mengirim notifikasi lunas...`);
                const ok = await notifyCustomer(
                  sock,
                  lidStore,
                  notifyTag,
                  waWrap(
                    '✅ *PEMBAYARAN BERHASIL*',
                    `Invoice *#${targetInvId}* sudah *LUNAS*.\n` +
                      `👤 *Nama:* ${customerName}\n` +
                      `📅 *Periode:* ${targetInv.period_month}/${targetInv.period_year}\n` +
                      `💰 *Total:* ${formatter.format(Number(targetInv.amount || 0))}\n\n` +
                      `🟢 Layanan internet Anda sudah aktif kembali.\n\n` +
                      `Terima kasih.`
                  )
                );
                await reply(`✅ Invoice *#${targetInvId}* LUNAS. Pelanggan *${customerName}* otomatis diaktifkan kembali.\n📩 Notif pelanggan: ${ok ? 'terkirim' : 'gagal'}`);
              } else {
                logger.info(`[WA lunas] Customer masih memiliki ${unpaidCount} invoice unpaid, notif dikirim...`);
                const ok = await notifyCustomer(
                  sock,
                  lidStore,
                  notifyTag,
                  waWrap(
                    '✅ *PEMBAYARAN BERHASIL*',
                    `Invoice *#${targetInvId}* sudah *LUNAS*.\n` +
                      `👤 *Nama:* ${customerName}\n` +
                      `📅 *Periode:* ${targetInv.period_month}/${targetInv.period_year}\n` +
                      `💰 *Total:* ${formatter.format(Number(targetInv.amount || 0))}\n\n` +
                      `⚠️ Masih ada ${unpaidCount} tagihan lain yang belum dibayar.\n\n` +
                      `Terima kasih.`
                  )
                );
                await reply(`✅ Invoice *#${targetInvId}* LUNAS. (Masih ada ${unpaidCount} tagihan lain, isolir tetap aktif)\n📩 Notif pelanggan: ${ok ? 'terkirim' : 'gagal'}`);
              }
            } else {
              logger.info(`[WA lunas] Customer tidak suspended atau null, mengirim notifikasi lunas...`);
              const ok = await notifyCustomer(
                sock,
                lidStore,
                notifyTag,
                waWrap(
                  '✅ *PEMBAYARAN BERHASIL*',
                  `Invoice *#${targetInvId}* sudah *LUNAS*.\n` +
                    `👤 *Nama:* ${customerName}\n` +
                    `📅 *Periode:* ${targetInv.period_month}/${targetInv.period_year}\n` +
                    `💰 *Total:* ${formatter.format(Number(targetInv.amount || 0))}\n\n` +
                    `Terima kasih.`
                )
              );
              await reply(`✅ Invoice *#${targetInvId}* (a.n ${customerName}) berhasil ditandai LUNAS.\n📩 Notif pelanggan: ${ok ? 'terkirim' : 'gagal'}`);
            }
          } catch (e) {
            logger.error('[WA lunas] Gagal update status: ' + e.message);
            await reply('❌ Gagal update status: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'isolir') {
          try {
            const cust = customerSvc.findCustomerByAny(parsed.targetId);
            if (!cust) return await reply(`❌ Pelanggan *${parsed.targetId}* tidak ditemukan.`);
            await customerSvc.suspendCustomer(cust.id);
            await reply(`✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil di-isolir.`);
          } catch (e) {
            await reply('❌ Gagal isolir: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'buka') {
          try {
            const cust = customerSvc.findCustomerByAny(parsed.targetId);
            if (!cust) return await reply(`❌ Pelanggan *${parsed.targetId}* tidak ditemukan.`);
            await customerSvc.activateCustomer(cust.id);
            await reply(`✅ Pelanggan *${cust.name}* (ID: ${cust.id}) berhasil diaktifkan kembali.`);
          } catch (e) {
            await reply('❌ Gagal buka isolir: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'generate') {
          try {
            const count = billingSvc.generateMonthlyInvoices(parseInt(parsed.month), parseInt(parsed.year));
            await reply(`✅ Berhasil generate *${count}* tagihan untuk periode ${parsed.month}/${parsed.year}.`);
          } catch (e) {
            await reply('❌ Gagal generate: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'digiflazz_balance') {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          try {
            const r = await agentSvc.digiflazzCheckBalance();
            await reply(`🏦 *SALDO DIGIFLAZZ*\n\n💳 Deposit: Rp ${Number(r?.deposit || 0).toLocaleString('id-ID')}`);
          } catch (e) {
            await reply('❌ Gagal cek saldo Digiflazz: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.cmd === 'topupagent') {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          try {
            const agentKeyRaw = String(parsed.agentKey || '').trim();
            const amount = Number(String(parsed.amount || '').replace(/[^\d]/g, '')) || 0;
            if (!agentKeyRaw) throw new Error('Agent username/id tidak valid');
            if (!amount) throw new Error('Nominal tidak valid');

            const normalizeDigits = (v) => {
              let d = String(v || '').replace(/\D/g, '');
              if (!d) return '';
              if (d.startsWith('0')) d = '62' + d.slice(1);
              return d;
            };

            const agentKey = agentKeyRaw.startsWith('@') ? agentKeyRaw.slice(1) : agentKeyRaw;
            const agentKeyLc = agentKey.toLowerCase();
            const agentDigits = normalizeDigits(agentKey);

            const agents = agentSvc.getAllAgents();
            const candidates = [];

            const byId = /^\d+$/.test(agentKey) ? agents.find(a => Number(a?.id) === Number(agentKey)) : null;
            if (byId) candidates.push(byId);

            const byUsername = agents.find(a => String(a?.username || '').toLowerCase() === agentKeyLc) || null;
            if (byUsername) candidates.push(byUsername);

            if (agentDigits) {
              const byPhone = agents.find(a => normalizeDigits(a?.phone || '') === agentDigits) || null;
              if (byPhone) candidates.push(byPhone);
            }

            const byNameExact = agents.find(a => String(a?.name || '').trim().toLowerCase() === agentKeyLc) || null;
            if (byNameExact) candidates.push(byNameExact);

            let agent = candidates.length > 0 ? candidates[0] : null;
            if (!agent) {
              const byNameContains = agents.filter(a => String(a?.name || '').trim().toLowerCase().includes(agentKeyLc));
              if (byNameContains.length === 1) agent = byNameContains[0];
              if (!agent && byNameContains.length > 1) {
                const list = byNameContains.slice(0, 8).map(a => `- ${a.name} (@${a.username}) [ID:${a.id}]`).join('\n');
                throw new Error(`Nama agent lebih dari satu. Gunakan username/ID/nohp.\n\n${list}`);
              }
            }
            if (!agent) throw new Error('Agent tidak ditemukan');

            const phone = getPhoneFromKey(m.key);
            const actorName = phone ? `Admin WA (${phone})` : 'Admin WA';
            const note = String(parsed.note || '').trim() || 'Transfer saldo via WhatsApp';
            const r = agentSvc.topupAgent(agent.id, amount, note, actorName);
            await reply(
              `✅ *TOPUP AGENT BERHASIL*\n\n` +
              `👤 Agent: *${agent.name}* (@${agent.username})\n` +
              `💸 Nominal: Rp ${Number(amount || 0).toLocaleString('id-ID')}\n` +
              `💳 Saldo: Rp ${Number(r.before || 0).toLocaleString('id-ID')} ➜ Rp ${Number(r.after || 0).toLocaleString('id-ID')}\n` +
              `📝 Catatan: ${note}`
            );
          } catch (e) {
            await reply('❌ Gagal topup agent: ' + e.message);
          }
          continue;
        }

        if (parsed.cmd === 'agent_pulsa') {
          try {
            const phone = getPhoneFromKey(m.key);
            const agent = phone ? agentSvc.getAgentByPhone(phone) : null;

            const sku = String(parsed.sku || '').trim();
            const target = String(parsed.target || '').trim();
            const sellPrice = Math.max(0, Math.floor(Number(parsed.sellPrice || 0) || 0));

            if (agent) {
              const result = await agentSvc.buyPulsaAsAgent(agent.id, sku, target, { sell_price: sellPrice });
              const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
              const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';

              const lines = [];
              lines.push(`${icon} *TRANSAKSI PULSA*`);
              lines.push('');
              lines.push(`👤 Agent: *${agent.name}* (@${agent.username})`);
              lines.push(`📦 SKU: *${sku}*`);
              lines.push(`🎯 Target: *${target}*`);
              lines.push(`🧾 TX ID: *#${result?.tx?.id || '-'}*`);
              lines.push(`🧾 Ref ID: *${result?.tx?.digi_ref_id || '-'}*`);
              lines.push(`📡 Status: *${status.toUpperCase()}*`);
              if (result?.tx?.digi_sn) lines.push(`🔢 SN: *${result.tx.digi_sn}*`);
              if (result?.tx?.digi_message) lines.push(`💬 Pesan: ${result.tx.digi_message}`);
              lines.push(`💰 Potong Saldo: Rp ${(Number(result?.tx?.amount_sell || 0) || 0).toLocaleString('id-ID')}`);
              lines.push(`💳 Sisa Saldo: Rp ${(Number(result?.agent?.balance || 0) || 0).toLocaleString('id-ID')}`);
              if (status === 'pending') lines.push(`\nKetik: \`cekpulsa ${result?.tx?.id || ''}\` untuk cek ulang.`);
              await reply(lines.join('\n'));
              continue;
            }

            if (!isAdmin) {
              await reply('❌ Nomor ini tidak terdaftar sebagai agent.');
              continue;
            }

            const result = await agentSvc.buyPulsaAsAdmin({
              sku,
              target,
              actorPhone: phone || '',
              actorName: 'WhatsApp Admin'
            });
            const status = String(result?.tx?.status || 'pending').toLowerCase();
            const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
            const lines = [];
            lines.push(`${icon} *TRANSAKSI PULSA (ADMIN)*`);
            lines.push('');
            lines.push(`📦 SKU: *${sku}*`);
            lines.push(`🎯 Target: *${target}*`);
            lines.push(`🧾 TX ID: *#${result?.tx?.id || '-'}*`);
            lines.push(`🧾 Ref ID: *${result?.tx?.ref_id || '-'}*`);
            lines.push(`📡 Status: *${status.toUpperCase()}*`);
            if (result?.tx?.sn) lines.push(`🔢 SN: *${result.tx.sn}*`);
            if (result?.tx?.message) lines.push(`💬 Pesan: ${result.tx.message}`);
            if (Number(result?.tx?.price || 0) > 0) lines.push(`💰 Harga Vendor: Rp ${Number(result.tx.price || 0).toLocaleString('id-ID')}`);
            if (status === 'pending') lines.push(`\nKetik: \`cekpulsa ${result?.tx?.id || ''}\` untuk cek ulang.`);
            await reply(lines.join('\n'));
          } catch (e) {
            await reply('❌ Gagal transaksi pulsa: ' + e.message);
          }
          continue;
        }

        if (parsed.cmd === 'agent_pulsa_check') {
          try {
            const phone = getPhoneFromKey(m.key);
            const agent = phone ? agentSvc.getAgentByPhone(phone) : null;
            const txId = Number(String(parsed.txId || '').replace(/[^\d]/g, '')) || 0;
            if (!txId) {
              await reply('❌ Format salah. Gunakan: `cekpulsa TXID`');
              continue;
            }

            if (agent) {
              const result = await agentSvc.checkPulsaStatusAsAgent(agent.id, txId);
              const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
              const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
              const lines = [];
              lines.push(`${icon} *STATUS PULSA*`);
              lines.push('');
              lines.push(`🧾 TX ID: *#${txId}*`);
              lines.push(`🧾 Ref ID: *${result?.tx?.digi_ref_id || '-'}*`);
              lines.push(`📡 Status: *${status.toUpperCase()}*`);
              if (result?.tx?.digi_sn) lines.push(`🔢 SN: *${result.tx.digi_sn}*`);
              if (result?.tx?.digi_message) lines.push(`💬 Pesan: ${result.tx.digi_message}`);
              await reply(lines.join('\n'));
              continue;
            }

            if (!isAdmin) {
              await reply('❌ Nomor ini tidak terdaftar sebagai agent.');
              continue;
            }

            const result = await agentSvc.checkPulsaStatusAsAdmin(txId);
            const status = String(result?.tx?.status || 'pending').toLowerCase();
            const icon = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
            const lines = [];
            lines.push(`${icon} *STATUS PULSA (ADMIN)*`);
            lines.push('');
            lines.push(`🧾 TX ID: *#${txId}*`);
            lines.push(`🧾 Ref ID: *${result?.tx?.ref_id || '-'}*`);
            lines.push(`📡 Status: *${status.toUpperCase()}*`);
            if (result?.tx?.sn) lines.push(`🔢 SN: *${result.tx.sn}*`);
            if (result?.tx?.message) lines.push(`💬 Pesan: ${result.tx.message}`);
            await reply(lines.join('\n'));
          } catch (e) {
            await reply('❌ Gagal cek status pulsa: ' + e.message);
          }
          continue;
        }

        if (parsed.admin && parsed.targetTag) {
          if (!isAdmin) {
            await reply('❌ Akses ditolak. Perintah ini khusus admin.');
            continue;
          }
          const targetTag = await resolveTargetTagForAdmin(parsed.targetTag);
          const targetDevice = await customerDevice.resolveDeviceToken(targetTag);
          if (!targetDevice) {
            await reply(`❌ Target *${parsed.targetTag}* tidak ditemukan di GenieACS.`);
            continue;
          }
          if (parsed.cmd === 'info') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatInfo(data));
            continue;
          }
          if (parsed.cmd === 'cekterhubung') {
            const data = await customerDevice.getCustomerDeviceData(targetTag);
            await reply(formatCekTerhubung(data));
            continue;
          }
          if (parsed.cmd === 'gantissid') {
            if (!parsed.rest) {
              await reply('❌ Format salah. Gunakan: \`gantissid TAG namaSSID\`');
              continue;
            }
            const ok = await customerDevice.updateSSID(targetTag, parsed.rest);
            if (ok) {
              await reply(`✅ SSID berhasil diubah menjadi:\n\n📶 *${parsed.rest}*`);
              // Kirim notifikasi ke pelanggan
              const now = getNowLocal();
              const cust = customerSvc.findCustomerByAny(targetTag);
              const custName = cust?.name ? `👤 *Pelanggan:* ${cust.name}\n` : '';
              const notifMsg =
                `📶 *PERUBAHAN SSID WIFI*\n\n` +
                custName +
                `🏷️ *Tag/ID:* ${targetTag}\n` +
                `🕒 *Waktu:* ${now}\n\n` +
                `SSID WiFi Anda sudah diperbarui oleh Admin menjadi:\n` +
                `📡 *${parsed.rest}*\n\n` +
                `Jika perangkat belum tersambung, silakan pilih SSID baru di HP/laptop Anda.\n` +
                `⚠️ Jangan bagikan info ini ke orang lain.`;
              const notifSent = await notifyCustomer(sock, lidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah SSID.');
            }
            continue;
          }
          if (parsed.cmd === 'gantisandi') {
            if (!parsed.rest || parsed.rest.length < 8) {
              await reply('❌ Sandi minimal 8 karakter.');
              continue;
            }
            const ok = await customerDevice.updatePassword(targetTag, parsed.rest);
            if (ok) {
              await reply('✅ Password WiFi berhasil diubah.');
              // Kirim notifikasi ke pelanggan
              const now = getNowLocal();
              const cust = customerSvc.findCustomerByAny(targetTag);
              const custName = cust?.name ? `👤 *Pelanggan:* ${cust.name}\n` : '';
              const notifMsg =
                `🔑 *PERUBAHAN PASSWORD WIFI*\n\n` +
                custName +
                `🏷️ *Tag/ID:* ${targetTag}\n` +
                `🕒 *Waktu:* ${now}\n\n` +
                `Password WiFi Anda sudah diperbarui oleh Admin menjadi:\n` +
                `🔐 *${parsed.rest}*\n\n` +
                `Silakan gunakan password baru untuk terhubung.\n` +
                `⚠️ Jangan bagikan password ini ke orang lain.`;
              const notifSent = await notifyCustomer(sock, lidStore, targetTag, notifMsg);
              if (notifSent) {
                await reply(`📤 Notifikasi terkirim ke pelanggan *${targetTag}*`);
              } else {
                await reply(`⚠️ Tidak dapat mengirim notifikasi ke pelanggan *${targetTag}* (nomor belum terdaftar)`);
              }
            } else {
              await reply('❌ Gagal mengubah password.');
            }
            continue;
          }
          if (parsed.cmd === 'reboot') {
            const r = await customerDevice.requestReboot(targetTag);
            await reply(`🔄 *${targetTag}*\n\n${r.message}`);
            continue;
          }
        }

        if (parsed.cmd === 'daftar') {
          if (!parsed.rest) {
            await reply('❌ Format salah. Gunakan:\n\n\`daftar 081234567890\`\n\n(gunakan tag/nomor yang sama dengan di GenieACS)');
            continue;
          }
          const dev = await customerDevice.resolveDeviceToken(parsed.rest);
          if (!dev) {
            await reply('❌ Tag/nomor tidak ditemukan di GenieACS. Periksa penulisan atau hubungi admin.');
            continue;
          }
          const nk = normalizeKey(m.key);
          const tagKey = String(parsed.rest || '').trim();
          lidStore.set(remote, tagKey);
          if (nk.senderLid) lidStore.set(nk.senderLid, tagKey);
          if (nk.senderPn) lidStore.set(nk.senderPn, tagKey);
          await reply(`✅ Berhasil! Nomor WA ini diikat ke tag:\n\n📍 *${tagKey}*\n\nSilakan gunakan perintah lain.`);
          continue;
        }

        const ctx = await resolveCustomerContext(m.key, lidStore);
        if (!ctx) {
          await reply(
            '❌ Nomor/tag Anda belum dikenali (sering terjadi jika WA memakai @lid).\n\n' +
            'Kirim sekali:\n\`daftar NOMORATAUTAG\`\n(sama persis dengan tag di GenieACS), lalu ulangi perintah.'
          );
          continue;
        }

        if (parsed.cmd === 'cektagihan') {
          const invoices = billingSvc.getInvoicesByAny(ctx.billingKey);
          let body = formatCustomerInvoices(invoices, ctx.billingKey);
          if (parsed.fuzzy) {
            body = `🧠 *Maksud Anda cek tagihan?*\n\n${body}`;
          }
          await reply(body);
          continue;
        }

        if (parsed.cmd === 'info') {
          const data = await customerDevice.getCustomerDeviceData(ctx.deviceKey);
          let body = formatInfo(data);
          if (parsed.fuzzy) {
            body = `🧠 *Maksud Anda cek status internet?*\n\n${body}`;
          }
          await reply(body);
          continue;
        }

        if (parsed.cmd === 'cekterhubung') {
          const data = await customerDevice.getCustomerDeviceData(ctx.deviceKey);
          let body = formatCekTerhubung(data);
          if (parsed.fuzzy) {
            body = `🧠 *Maksud Anda cek perangkat terhubung?*\n\n${body}`;
          }
          await reply(body);
          continue;
        }

        if (parsed.cmd === 'gantissid') {
          const phone = getPhoneFromKey(m.key);
          if (!parsed.rest) {
            setConversationState(phone, 'await_ssid', { deviceKey: ctx.deviceKey, billingKey: ctx.billingKey });
            await reply('📶 *Ganti Nama WiFi*\n\nSilakan kirim nama WiFi baru yang diinginkan.\nContoh: `WiFiRumahKu`');
            continue;
          }
          clearConversationState(phone);
          const ok = await customerDevice.updateSSID(ctx.deviceKey, parsed.rest);
          if (ok) {
            await reply(`✅ SSID berhasil diubah menjadi:\n\n📶 *${parsed.rest}*`);
            // Kirim notifikasi konfirmasi ke pelanggan via WA
            try {
              const cust = customerSvc.findCustomerByAny(ctx.billingKey || ctx.deviceKey);
              if (cust && cust.phone) {
                const now = getNowLocal();
                const notifMsg =
                  `📶 *PERUBAHAN SSID WIFI*\n\n` +
                  `👤 *Pelanggan:* ${cust.name}\n` +
                  `🕒 *Waktu:* ${now}\n\n` +
                  `SSID WiFi Anda sudah diperbarui menjadi:\n` +
                  `📡 *${parsed.rest}*\n\n` +
                  `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
                  `⚠️ Jangan bagikan info ini ke orang lain.`;
                await notifyCustomer(sock, lidStore, ctx.deviceKey, notifMsg);
              }
            } catch (e) { /* ignore notification errors */ }
          } else {
            await reply('❌ Gagal mengubah SSID. Coba lagi atau hubungi admin.');
          }
          continue;
        }

        if (parsed.cmd === 'gantisandi') {
          const phone = getPhoneFromKey(m.key);
          if (!parsed.rest) {
            setConversationState(phone, 'await_password', { deviceKey: ctx.deviceKey, billingKey: ctx.billingKey });
            await reply('🔑 *Ganti Password WiFi*\n\nSilakan kirim password baru minimal 8 karakter.\nContoh: `SandiBaru123`');
            continue;
          }
          if (parsed.rest.length < 8) {
            await reply('⚠️ Password minimal 8 karakter. Silakan kirim ulang password yang lebih panjang.');
            continue;
          }
          clearConversationState(phone);
          const ok = await customerDevice.updatePassword(ctx.deviceKey, parsed.rest);
          if (ok) {
            await reply('✅ Password WiFi berhasil diubah.');
            // Kirim notifikasi konfirmasi ke pelanggan via WA
            try {
              const cust = customerSvc.findCustomerByAny(ctx.billingKey || ctx.deviceKey);
              if (cust && cust.phone) {
                const now = getNowLocal();
                const notifMsg =
                  `🔑 *PERUBAHAN PASSWORD WIFI*\n\n` +
                  `👤 *Pelanggan:* ${cust.name}\n` +
                  `🕒 *Waktu:* ${now}\n\n` +
                  `Password WiFi Anda sudah diperbarui menjadi:\n` +
                  `🔐 *${parsed.rest}*\n\n` +
                  `Silakan gunakan password baru untuk terhubung.\n` +
                  `⚠️ Jangan bagikan password ini ke orang lain.`;
                await notifyCustomer(sock, lidStore, ctx.deviceKey, notifMsg);
              }
            } catch (e) { /* ignore notification errors */ }
          } else {
            await reply('❌ Gagal mengubah password.');
          }
          continue;
        }

        if (parsed.cmd === 'reboot') {
          const r = await customerDevice.requestReboot(ctx.deviceKey);
          let body = `🔄 *Reboot ONU*\n\n${r.message}`;
          if (parsed.fuzzy) {
            body = `🧠 *Maksud Anda restart modem?*\n\n${body}`;
          }
          await reply(body);
        }
      } catch (e) {
        logger.error('WhatsApp message handler:', e.message || e);
      }
    }
  });
}

/** Temukan command yang paling mirip dengan kata pertama untuk saran fallback. */
function suggestClosestCommand(text, isAdmin = false) {
  const norm = normalizeForMatch(text);
  const firstWord = norm.split(' ')[0];
  if (!firstWord || firstWord.length < 3) return null;

  const candidates = isAdmin
    ? ['saldodigi', 'topup', 'ringkasan', 'lunas', 'generate', 'isolir', 'buka', 'listonu', 'mtactive', 'kickuser']
    : ['menu', 'cektagihan', 'info', 'cekterhubung', 'reboot', 'gantissid', 'gantisandi'];

  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = levenshtein(firstWord, c);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  if (best && bestDist <= 2) return best;
  return null;
}

/** Cek apakah pesan mengandung ucapan terima kasih / oke (untuk respon simpatik tanpa command). */
function detectCourtesy(text) {
  const norm = normalizeForMatch(text);
  if (/\b(terima\s*kasih|thanks?|makasih| trims|matur\s*nuwun)\b/.test(norm)) return 'thanks';
  if (/\b(oke\s*(siap|mantap|terima\s*kasih)?|siap\s*(terima\s*kasih)?|baik\s*(terima\s*kasih)?|ok\s*(siap)?)\b/.test(norm)) return 'ok';
  return null;
}
