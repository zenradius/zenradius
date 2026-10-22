/**
 * aiAssistantService.js
 * Asisten AI ZenRadius (Gemini) untuk admin & pelanggan — dengan function calling,
 * konteks operasional live (pelanggan, tagihan, MikroTik, GenieACS), knowledge base
 * fitur aplikasi, serta fallback jawaban cerdas berbasis kata kunci saat offline.
 *
 * Diadaptasi dari alijayanet/billing-rtrw `services/telegramAiService.js`.
 */

const axios = require('axios');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const { adminToolDeclarations, executeAdminTool } = require('./aiAdminTools');

/** Daftar model fallback bila model utama tidak tersedia / kena limit. */
const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];

/** Ringkasan fitur aplikasi ZenRadius sebagai knowledge base (cache 1 jam). */
let cachedKnowledge = null;
let lastLoadTime = 0;
const KNOWLEDGE_RELOAD_INTERVAL = 3600000;

function loadKnowledgeBase() {
  const now = Date.now();
  if (cachedKnowledge && (now - lastLoadTime < KNOWLEDGE_RELOAD_INTERVAL)) {
    return cachedKnowledge;
  }

  const company = getSetting('company_header', 'ZenRadius');
  cachedKnowledge = `Aplikasi: ${company} — Sistem Billing & Manajemen Jaringan ISP (WhatsApp/Telegram AI Assistant).

Tech Stack: Node.js (>=20), Express, SQLite (better-sqlite3, WAL), EJS, Baileys WhatsApp, RouterOS API, SNMP OLT, GenieACS TR-069, FreeRADIUS (opsional).

FITUR UTAMA:
1. Billing & Invoicing: Generate invoice otomatis per periode, promo & prorata, pengingat jatuh tempo via WhatsApp, auto isolir saat lewat jatuh tempo, kode unik pembayaran, denda keterlambatan.
2. MikroTik: Multi-router, sinkronisasi PPPoE secret & user hotspot, auto create/update profile, isolir via address-list/pool, kick sesi aktif, voucher hotspot (template Mikhmon).
3. GenieACS & TR-069: Auto provisioning ONU baru, monitoring redaman (RX power), reboot ONU jarak jauh, ganti SSID & sandi WiFi langsung dari portal/bot, status WAN & uptime PPPoE.
4. OLT & SNMP: Monitoring port PON & uplink, auto-discovery ONU belum terdaftar (EPON/GPON: HIOSO, VSOL, ZTE, Huawei, dll), provisi ONU dari web.
5. Payment: iPaymu, QRIS dinamis & statis + kode unik, verifikasi notifikasi otomatis, gateway HTTP/webhook kustom.
6. WhatsApp & Telegram: Notifikasi tagihan, broadcast massal, chatbot AI pelanggan (cek tagihan, status ONU, reboot, ganti WiFi), bot admin & asisten AI dengan function calling.
7. Portal Pelanggan: Cek tagihan tanpa login, riwayat invoice, ganti WiFi mandiri, beli voucher, top up saldo, tiket/keluhan, PWA.
8. Agent/Reseller: Saldo agent, jual voucher & pulsa (Digiflazz), komisi, laporan transaksi.
9. Kolektor & Teknisi: Portal absensi (GPS + foto), tugas penagihan, monitoring gangguan.
10. Keamanan & Lisensi: Enkripsi settings terpilih, audit trail, backup otomatis (S3/local), verifikasi lisensi domain, update aplikasi dari Git.
11. i18n: Dukungan Bahasa Indonesia & Inggris.

TROUBLESHOOTING UMUM:
• Sudah bayar tapi masih isolir → buka isolir manual (buka <nama/ID>) atau hapus IP dari address-list isolir, kick sesi PPPoE.
• MikroTik API timeout → aktifkan service api (/ip service enable api), buka firewall port 8728/8729, cek host/user/password di menu Routers.
• Redaman jelek/LOS → -15 s/d -22 dBm ideal; -26 s/d -28 dBm bermasalah; LOS (merah) berarti kabel putus, cek ODP/OPM lalu splicing ulang.
• QRIS/webhook tidak otomatis lunas → pastikan URL callback terdaftar di dashboard merchant & app_url memakai https.
• WhatsApp "menunggu pesan ini" → minta pengirim mengirim pesan teks biasa untuk sinkronisasi kunci enkripsi; reset sesi bila status 401.
• Telegram 409 Conflict → ada 2 proses bot dengan token sama; hentikan salah satu.
• Database locked → WAL sudah aktif; restart service jika stuck; backup harian ada di folder backups/.`;
  lastLoadTime = now;
  return cachedKnowledge;
}

/**
 * Ambil konteks operasional live seluruh pelanggan + MikroTik + GenieACS untuk admin.
 */
async function getAdminGlobalContext(userQuestion) {
  try {
    const db = require('../config/database');
    const customerDevice = require('./customerDeviceService');
    const mikrotikService = require('./mikrotikService');

    const query = `
      SELECT
        c.id, c.name, c.phone, c.status, c.pppoe_username, c.genieacs_tag, c.area,
        p.name as package_name, p.price as package_price,
        COUNT(CASE WHEN i.status != 'paid' THEN 1 END) as unpaid_count,
        COALESCE(SUM(CASE WHEN i.status != 'paid' THEN i.amount ELSE 0 END), 0) as unpaid_amount
      FROM customers c
      LEFT JOIN packages p ON c.package_id = p.id
      LEFT JOIN invoices i ON c.id = i.customer_id
      GROUP BY c.id
      ORDER BY c.id ASC
    `;
    const customers = db.prepare(query).all();

    const total = customers.length;
    const active = customers.filter(c => String(c.status || '').toLowerCase() === 'active').length;
    const isolated = customers.filter(c => ['isolated', 'suspended', 'isolir'].includes(String(c.status || '').toLowerCase())).length;
    const inactive = customers.filter(c => ['inactive', 'nonaktif', 'terminated'].includes(String(c.status || '').toLowerCase())).length;
    const unpaidCustomers = customers.filter(c => Number(c.unpaid_count) > 0);
    const totalUnpaidAmount = unpaidCustomers.reduce((acc, c) => acc + Number(c.unpaid_amount || 0), 0);

    let contextText = `=== RINGKASAN GLOBAL SISTEM (REALTIME ADMIN CONTEXT) ===\n`;
    contextText += `Total Pelanggan Terdaftar: ${total} pelanggan\n`;
    contextText += `- Aktif: ${active} pelanggan\n`;
    contextText += `- Terisolir / Suspended: ${isolated} pelanggan\n`;
    contextText += `- Non-Aktif / Terminated: ${inactive} pelanggan\n`;
    contextText += `Tunggakan Belum Lunas: ${unpaidCustomers.length} pelanggan (Total Tunggakan: Rp ${totalUnpaidAmount.toLocaleString('id-ID')})\n\n`;

    contextText += `=== DIREKTORI SELURUH PELANGGAN (ID | Nama | No HP | Status | PPPoE | Paket | Tunggakan) ===\n`;
    for (const c of customers) {
      const unpaidStr = Number(c.unpaid_count) > 0
        ? `${c.unpaid_count} tagihan (Rp ${Number(c.unpaid_amount).toLocaleString('id-ID')})`
        : 'Lunas';
      contextText += `[ID:${c.id}] ${c.name} | ${c.phone || '-'} | Status: ${c.status} | PPPoE: ${c.pppoe_username || '-'} | Pkt: ${c.package_name || '-'} | Tunggakan: ${unpaidStr}\n`;
    }
    contextText += `\n`;

    // Deteksi pelanggan yang ditanyakan secara spesifik
    const qLower = String(userQuestion || '').toLowerCase();
    const matchedCustomers = [];
    const STOPWORDS = ['bisa', 'tolong', 'admin', 'saya', 'yang', 'dari', 'untuk', 'paket', 'status', 'kabel', 'modem', 'wifi', 'cek', 'berapa', 'apakah', 'siapa', 'kenapa'];

    for (const c of customers) {
      let isMatch = false;
      const name = String(c.name || '').toLowerCase().trim();
      const pppoe = String(c.pppoe_username || '').toLowerCase().trim();
      const phoneDigits = String(c.phone || '').replace(/\D/g, '');
      const tag = String(c.genieacs_tag || '').toLowerCase().trim();
      const idStr = String(c.id);

      if (new RegExp(`\\b(id|#)\\s*${idStr}\\b`, 'i').test(qLower)) isMatch = true;
      else if (phoneDigits.length >= 8 && qLower.includes(phoneDigits.slice(-8))) isMatch = true;
      else if (pppoe.length >= 3 && qLower.includes(pppoe)) isMatch = true;
      else if (tag.length >= 3 && qLower.includes(tag)) isMatch = true;
      else if (name.length >= 3) {
        if (qLower.includes(name)) isMatch = true;
        else {
          const words = name.split(/\s+/).filter(w => w.length >= 4);
          for (const w of words) {
            if (STOPWORDS.includes(w)) continue;
            if (qLower.includes(w)) { isMatch = true; break; }
          }
        }
      }

      if (isMatch) {
        matchedCustomers.push(c);
        if (matchedCustomers.length >= 3) break;
      }
    }

    // Deep-dive pelanggan yang cocok (invoices + GenieACS + MikroTik)
    if (matchedCustomers.length > 0) {
      contextText += `=== DETAIL MENDALAM PELANGGAN YANG DITANYAKAN ===\n`;

      let activeSessionsMap = new Map();
      try {
        activeSessionsMap = await Promise.race([
          mikrotikService.getActivePppoeSessionsMap(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('MikroTik timeout')), 4000))
        ]);
      } catch (_) { activeSessionsMap = new Map(); }
      if (!activeSessionsMap || typeof activeSessionsMap.get !== 'function') activeSessionsMap = new Map();

      for (const mc of matchedCustomers) {
        const invRows = db.prepare('SELECT id, period_month, period_year, amount, status, paid_at FROM invoices WHERE customer_id = ? ORDER BY id DESC LIMIT 5').all(mc.id);
        const unpaidInvs = invRows.filter(i => i.status !== 'paid');
        const paidInvs = invRows.filter(i => i.status === 'paid');

        let onuData = null;
        const lookupTag = mc.genieacs_tag || mc.pppoe_username || mc.phone;
        if (lookupTag) {
          try {
            onuData = await Promise.race([
              customerDevice.getCustomerDeviceData(lookupTag),
              new Promise((_, reject) => setTimeout(() => reject(new Error('GenieACS timeout')), 4000))
            ]);
          } catch (_) { onuData = null; }
        }

        const pppoeUser = String(mc.pppoe_username || '').toLowerCase();
        const pppoeSession = pppoeUser ? activeSessionsMap.get(pppoeUser) : null;

        contextText += `\n>> PELANGGAN: ${mc.name} (ID: ${mc.id})\n`;
        contextText += `  - No HP: ${mc.phone || '-'}\n`;
        contextText += `  - Status Billing: ${mc.status}\n`;
        contextText += `  - Area: ${mc.area || '-'}\n`;
        contextText += `  - Paket: ${mc.package_name || '-'} (Rp ${Number(mc.package_price || 0).toLocaleString('id-ID')}/bulan)\n`;
        contextText += `  - Akun PPPoE: ${mc.pppoe_username || '-'}\n`;
        contextText += `  - Status PPPoE MikroTik: ${pppoeSession ? `ONLINE (IP: ${pppoeSession.ip || '-'}, Uptime: ${pppoeSession.uptime || '-'})` : 'OFFLINE / Belum dial'}\n`;

        if (onuData) {
          contextText += `  - Status Modem ONU: ${onuData.status || 'Unknown'}\n`;
          contextText += `  - Redaman Optical (RX Power): ${onuData.rxPower && onuData.rxPower !== '-' ? onuData.rxPower + ' dBm' : '-'}\n`;
          contextText += `  - Nama WiFi (SSID): ${onuData.ssid || '-'}\n`;
          contextText += `  - ONU Uptime: ${onuData.uptime || '-'}\n`;
          contextText += `  - Pengguna WiFi Terhubung: ${onuData.totalAssociations || 0} user\n`;
        } else {
          contextText += `  - Status Modem ONU: (Data modem belum terhubung / tag GenieACS belum diisi)\n`;
        }

        contextText += `  - Tunggakan: ${unpaidInvs.length > 0 ? unpaidInvs.map(i => `#${i.id} (${i.period_month}/${i.period_year}: Rp ${Number(i.amount).toLocaleString('id-ID')})`).join(', ') : 'TIDAK ADA (semua lunas)'}\n`;
        if (paidInvs.length > 0) {
          contextText += `  - Pembayaran Lunas Terakhir: #${paidInvs[0].id} (${paidInvs[0].period_month}/${paidInvs[0].period_year} sebesar Rp ${Number(paidInvs[0].amount).toLocaleString('id-ID')} pada ${paidInvs[0].paid_at || '-'})\n`;
        }
      }
    }

    return contextText;
  } catch (err) {
    logger.error(`[AI] Gagal mengambil admin global context: ${err.message}`);
    return '';
  }
}

/**
 * Panggil Google Gemini API (dengan function calling untuk admin).
 * @returns {Promise<{type:'text',text:string}|{type:'function_call',functionCall:{name:string,args:object}}>}
 */
async function callGeminiApi(apiKey, userQuestion, senderName = 'Member', customerContext = null, isAdmin = false, adminContext = null) {
  const knowledge = loadKnowledgeBase();
  const preferredModel = String(getSetting('gemini_model', DEFAULT_MODELS[0]) || DEFAULT_MODELS[0]).trim();
  const modelList = [preferredModel, ...DEFAULT_MODELS.filter(m => m !== preferredModel)];

  let systemInstruction = '';
  if (isAdmin) {
    systemInstruction = `Anda adalah "Asisten AI Eksekutif & Administrator Jaringan" untuk sistem billing ISP "${getSetting('company_header', 'ZenRadius')}".

Pedoman untuk Admin:
1. AKURAT & KOMPREHENSIF: Anda memiliki DATA OPERASIONAL LIVE (pelanggan, tagihan, MikroTik, GenieACS) di bawah. Jawab dengan data riil tersebut secara presisi.
2. PERTANYAAN PELANGGAN SPESIFIK: Jika admin menanyakan pelanggan tertentu ("apakah X nunggak?", "cek redaman X", "kenapa pelanggan X putus?"), sebutkan data lengkap (status billing, tunggakan, PPPoE, modem/redaman) secara to-the-point.
3. PERTANYAAN GLOBAL: Untuk ringkasan (jumlah isolir, daftar penunggak, total tunggakan), rangkum dengan angka pasti & sebut nama pelanggan terkait.
4. SISTEM/TEKNIS/TROUBLESHOOTING: Gunakan DOKUMENTASI SISTEM di bawah untuk diagnosis & solusi langkah demi langkah.
5. EKSEKUSI VIA TOOLS: Anda DILENGKAPI FUNCTION TOOLS untuk aksi administratif. Jika pesan admin berisi instruksi tindakan (tambah/hapus pelanggan, reboot ONU, ganti password/SSID WiFi, lunasi tagihan, isolir, buka isolir, kick user, buat voucher hotspot, generate invoice, cek saldo Digiflazz, top up agent), PANGGIL FUNCTION YANG SESUAI dengan parameter hasil ekstraksi percakapan.
   - Hapus pelanggan: SELALU pakai 'delete_customer_request' (konfirmasi 2 langkah).
   - Jika admin hanya BERTANYA informasi, JANGAN panggil tool pengubah data — jawab dengan teks.
6. Bahasa: Indonesia lugas, profesional, santun. Gunakan bullet points & *bold* (format WhatsApp/Telegram).

DATA OPERASIONAL LIVE (ADMIN ACCESS):
${adminContext || '(Tidak ada data kontekstual khusus)'}

DOKUMENTASI SISTEM:
${knowledge}
`;
  } else {
    let liveCustomerDataPrompt = '';
    if (customerContext) {
      const unpaidText = customerContext.hasUnpaid
        ? `MEMILIKI ${customerContext.unpaidCount} TAGIHAN BELUM LUNAS (Total: Rp ${Number(customerContext.totalUnpaidAmount || 0).toLocaleString('id-ID')})`
        : (customerContext.allPaid ? 'SEMUA TAGIHAN SUDAH LUNAS' : 'Belum ada data tagihan');
      liveCustomerDataPrompt = `
----------------------------------------
DATA STATUS LIVE PELANGGAN (Dari Database Billing):
- Nama Pelanggan: ${customerContext.customerName || senderName}
- Paket Layanan: ${customerContext.package || '-'}
- Akun PPPoE: ${customerContext.pppoeUsername || '-'}
- Status Langganan: ${customerContext.customerStatus || 'Active'}
- Status Tagihan Saat Ini: ${unpaidText}
${customerContext.unpaidInvoices ? `Rincian Tagihan Belum Lunas:\n${customerContext.unpaidInvoices}` : ''}

PETUNJUK TAGIHAN: Jika pelanggan menanyakan sisa tagihan/status pembayaran, gunakan DATA STATUS LIVE di atas (sebutkan nama, total, rincian periode). Jika sudah lunas, sampaikan terima kasih.
----------------------------------------
`;
    }

    systemInstruction = `Anda adalah "Asisten AI Layanan Pelanggan ${getSetting('company_header', 'ZenRadius')}", asisten ramah untuk pelanggan internet.

Pedoman:
1. Terkait aplikasi/fitur/troubleshooting jaringan (wifi lambat, tidak bisa internet, lampu modem merah/LOS, cara bayar, ganti sandi wifi, voucher), jawab mendalam & solutif menggunakan DOKUMENTASI SISTEM di bawah.
2. Jika ada DATA STATUS LIVE PELANGGAN, gunakan untuk menjawab pertanyaan tagihan pribadi secara presisi.
3. Pertanyaan umum di luar aplikasi tetap dijawab ramah & informatif.
4. Bahasa Indonesia santun, jelas, profesional. Gunakan bullet points & *bold*.
5. Padat dan to-the-point (maks 3-4 paragraf atau 5-8 poin).

${liveCustomerDataPrompt}

DOKUMENTASI SISTEM:
${knowledge}
`;
  }

  let lastError = null;

  for (const model of modelList) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const payload = {
        contents: [
          { role: 'user', parts: [{ text: `${systemInstruction}\n\nPertanyaan / Instruksi dari ${isAdmin ? 'Admin' : 'Pelanggan'} (${senderName}):\n${userQuestion}` }] }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024
        }
      };

      if (isAdmin && Array.isArray(adminToolDeclarations) && adminToolDeclarations.length > 0) {
        payload.tools = [{ functionDeclarations: adminToolDeclarations }];
      }

      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 25000
      });

      const parts = response.data?.candidates?.[0]?.content?.parts || [];

      const funcPart = parts.find(p => p.functionCall);
      if (funcPart && funcPart.functionCall) {
        return {
          type: 'function_call',
          functionCall: {
            name: funcPart.functionCall.name,
            args: funcPart.functionCall.args || {}
          }
        };
      }

      const textPart = parts.find(p => p.text && p.text.trim());
      if (textPart && textPart.text) {
        return { type: 'text', text: textPart.text.trim() };
      }
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 404) {
        logger.warn(`[AI] Model ${model} tidak tersedia (404), mencoba model cadangan...`);
        continue;
      }
      if (status === 429) {
        logger.warn(`[AI] Model ${model} kena limit (429), mencoba model cadangan...`);
        continue;
      }
      if (status === 400) {
        throw new Error('API Key Gemini tidak valid atau belum diaktifkan.');
      }
      logger.warn(`[AI] Error memanggil ${model}: ${err.message}`);
    }
  }

  throw lastError || new Error('Gagal mendapatkan respon dari AI.');
}

/**
 * Fallback jawaban cerdas berbasis kata kunci bila API key belum diisi / AI error.
 */
function getOfflineAnswer(question, customerContext = null, isAdmin = false, adminContext = null) {
  const q = String(question || '').toLowerCase();

  if (isAdmin) {
    try {
      const db = require('../config/database');

      // 1. Tunggakan
      if (q.includes('tunggak') || q.includes('belum bayar') || q.includes('piutang') || q.includes('nunggak') || (q.includes('tagihan') && !q.includes('pelanggan saya'))) {
        const unpaidList = db.prepare(`
          SELECT c.id, c.name, c.phone, COUNT(i.id) as count, SUM(i.amount) as total
          FROM customers c
          JOIN invoices i ON c.id = i.customer_id
          WHERE i.status != 'paid'
          GROUP BY c.id
          ORDER BY total DESC
        `).all();

        if (unpaidList.length === 0) {
          return `🎉 *Laporan Billing (Offline)*\n\nSaat ini *tidak ada pelanggan yang menunggak*. Semua tagihan sudah lunas!`;
        }

        const totalNominal = unpaidList.reduce((sum, item) => sum + Number(item.total || 0), 0);
        let resp = `📊 *LAPORAN TUNGGAKAN PELANGGAN (OFFLINE)*\n\n`;
        resp += `• Total Penunggak: *${unpaidList.length} pelanggan*\n`;
        resp += `• Total Nominal: *Rp ${totalNominal.toLocaleString('id-ID')}*\n\n`;
        resp += `*Daftar Pelanggan Menunggak:*\n`;
        unpaidList.slice(0, 15).forEach((c, idx) => {
          resp += `${idx + 1}. *${c.name}* (${c.phone || '-'}) - Rp ${Number(c.total).toLocaleString('id-ID')} [${c.count} tagihan]\n`;
        });
        if (unpaidList.length > 15) resp += `\n_...dan ${unpaidList.length - 15} pelanggan lainnya._`;
        return resp;
      }

      // 2. Isolir
      if (q.includes('isolir') || q.includes('suspend') || q.includes('putus') || q.includes('terisolir')) {
        const isolatedList = db.prepare(`
          SELECT id, name, phone, pppoe_username, area
          FROM customers
          WHERE LOWER(status) IN ('isolated', 'suspended', 'isolir')
          ORDER BY id ASC
        `).all();

        if (isolatedList.length === 0) {
          return `✅ *Laporan Status Isolir (Offline)*\n\nSaat ini *tidak ada pelanggan yang terisolir*. Semua pelanggan aktif/normal.`;
        }

        let resp = `🔒 *DAFTAR PELANGGAN TERISOLIR (Total: ${isolatedList.length})*\n\n`;
        isolatedList.slice(0, 30).forEach((c, idx) => {
          resp += `${idx + 1}. *${c.name}* | PPPoE: \`${c.pppoe_username || '-'}\` | Area: ${c.area || '-'}\n`;
        });
        return resp;
      }

      // 3. Ringkasan
      if (q.includes('total') || q.includes('berapa') || q.includes('rekap') || q.includes('ringkasan') || q.includes('statistik')) {
        const stats = db.prepare(`
          SELECT
            COUNT(*) as total,
            COUNT(CASE WHEN LOWER(status) = 'active' THEN 1 END) as active,
            COUNT(CASE WHEN LOWER(status) IN ('isolated', 'suspended', 'isolir') THEN 1 END) as isolated,
            COUNT(CASE WHEN LOWER(status) IN ('inactive', 'terminated', 'nonaktif') THEN 1 END) as inactive
          FROM customers
        `).get();

        return `📊 *RINGKASAN PELANGGAN (OFFLINE)*\n\n` +
          `• Total Terdaftar: *${stats.total} pelanggan*\n` +
          `• Aktif: *${stats.active} pelanggan*\n` +
          `• Terisolir: *${stats.isolated} pelanggan*\n` +
          `• Nonaktif: *${stats.inactive} pelanggan*`;
      }
    } catch (err) {
      logger.error(`[AI] Offline admin answer error: ${err.message}`);
    }
  }

  // Pelanggan menanyakan tagihan
  if (customerContext && (q.includes('tagihan') || q.includes('tunggak') || q.includes('bayar') || q.includes('lunas') || q.includes('tempo') || q.includes('invoice'))) {
    if (customerContext.hasUnpaid) {
      return `Halo Kak *${customerContext.customerName}*,\n\n` +
        `Saat ini Anda memiliki *${customerContext.unpaidCount} tagihan belum lunas* dengan total:\n` +
        `💰 *Rp ${Number(customerContext.totalUnpaidAmount || 0).toLocaleString('id-ID')}*\n\n` +
        `📋 *Rincian Tagihan:*\n${customerContext.unpaidInvoices}\n\n` +
        `💡 _Pembayaran dapat dilakukan via transfer bank atau QRIS di portal pelanggan, atau hubungi admin/kolektor._`;
    } else if (customerContext.allPaid) {
      return `Halo Kak *${customerContext.customerName}*,\n\n` +
        `✅ *Semua tagihan internet Anda sudah LUNAS!* Tidak ada tunggakan saat ini.\nTerima kasih atas kerja samanya. 🙏`;
    }
  }

  // === DIAGNOSTIK & TROUBLESHOOTING ===
  if (q.includes('masih isolir') || (q.includes('sudah bayar') && q.includes('isolir')) || (q.includes('lunas') && q.includes('isolir')) || q.includes('sudah bayar tapi')) {
    return `💡 *Solusi: Sudah Lunas Tapi Masih Terisolir*\n\n` +
      `*Penyebab:* IP pelanggan masih ada di address-list isolir MikroTik atau sesi PPPoE belum dial ulang.\n\n` +
      `*Langkah Perbaikan:*\n` +
      `1. *Via Web Billing:* Data Pelanggan ➜ klik *"Buka Isolir"*.\n` +
      `2. *Via Bot:* ketik \`buka <nama/ID pelanggan>\`.\n` +
      `3. *Via MikroTik:* hapus IP di \`/ip firewall address-list\` lalu kick sesi \`/interface pppoe-server\`.`;
  }

  if (q.includes('masih bisa') && (q.includes('isolir') || q.includes('suspend') || q.includes('putus'))) {
    return `💡 *Solusi: Pelanggan Isolir Tapi Masih Bisa Internetan*\n\n` +
      `*Penyebab:* Sesi PPPoE lama belum diputus atau rule NAT isolir berada di bawah rule masquerade umum.\n\n` +
      `*Langkah Perbaikan:*\n` +
      `1. Kick sesi aktif: \`kickuser <username>\`.\n` +
      `2. Pindahkan NAT rule isolir ke urutan teratas (\`/ip firewall nat\`).\n` +
      `3. Tambahkan drop/redirect DNS port 53 untuk address-list isolir.\n` +
      `4. Pastikan \`auto_isolate\` pelanggan bernilai \`1\`.`;
  }

  if (q.includes('tidak bisa konek') || q.includes('gagal konek') || q.includes('api timeout') || q.includes('port 8728') || q.includes('port 8729') || q.includes('service api') || (q.includes('mikrotik') && q.includes('error'))) {
    return `🔧 *Solusi: Gagal Terhubung ke MikroTik API (Port 8728/8729)*\n\n` +
      `*Penyebab:* Service API nonaktif, port salah, atau firewall memblokir.\n\n` +
      `*Langkah Perbaikan di MikroTik:*\n` +
      `1. Aktifkan API: \`/ip service enable api\`; \`/ip service set api port=8728\`.\n` +
      `2. Buka firewall input: \`/ip firewall filter add chain=input protocol=tcp dst-port=8728 action=accept place-before=0\`.\n` +
      `3. Cek menu Routers di web admin: host/port/user/password harus sama dengan yang bisa login Winbox (disarankan user khusus group \`full\`).`;
  }

  if ((q.includes('redaman') || q.includes('los') || q.includes('lampu merah') || q.includes('rx power')) ) {
    return `📡 *Panduan Redaman Optik & Solusi LOS (Lampu Merah)*\n\n` +
      `*Kategori RX Power:*\n` +
      `• -15 s/d -22 dBm: Sangat Baik\n• -23 s/d -25 dBm: Cukup / Ambang aman\n• -26 s/d -28 dBm: Buruk (packet loss)\n• < -28 dBm: Kritis (sering putus)\n• LOS (merah): Putus total\n\n` +
      `*Langkah Perbaikan:*\n` +
      `1. Redaman -25 s/d -28 dBm: bersihkan konektor SC patchcord (alkohol isopropil), cek tekukan dropcore.\n` +
      `2. LOS: ukur redaman di output ODP dengan OPM; jika ODP bagus, lacak kabel putus dengan VFL lalu splicing ulang.`;
  }

  if (q.includes('webhook') || (q.includes('qris') && (q.includes('gagal') || q.includes('belum lunas') || q.includes('tidak otomatis'))) || q.includes('ipaymu')) {
    return `💳 *Solusi: Pembayaran QRIS / Gateway Tidak Otomatis Lunas*\n\n` +
      `*Penyebab:* URL callback webhook belum terdaftar di dashboard merchant atau server belum HTTPS.\n\n` +
      `*Langkah Perbaikan:*\n` +
      `1. Daftarkan URL callback (iPaymu/midtrans/xendit/duitku) di dashboard merchant.\n` +
      `2. Pastikan \`app_url\` di settings memakai awalan \`https://\`.\n` +
      `3. *Solusi cepat:* jika bukti transfer valid, lunaskan manual via bot: \`lunas <ID_INVOICE>\`.`;
  }

  if (q.includes('menunggu pesan ini') || q.includes('waiting for this message') || q.includes('wa logout') || q.includes('reset sesi')) {
    return `💬 *Solusi: WhatsApp "Menunggu Pesan Ini" / Sering Terputus*\n\n` +
      `*Penyebab:* sinkronisasi prekey Signal antara Baileys dan pengirim belum selesai.\n\n` +
      `*Langkah:*\n` +
      `1. Minta pengirim mengirim pesan teks biasa ("Halo") agar kunci enkripsi tersinkron.\n` +
      `2. Hindari restart service WhatsApp berulang tanpa jeda.\n` +
      `3. Jika status 401 / Logout: Admin ➜ WhatsApp ➜ *Reset Sesi*, lalu scan ulang QR (pastikan HP bot stabil & hemat baterai nonaktif).`;
  }

  if (q.includes('telegram') && (q.includes('akses ditolak') || q.includes('conflict') || q.includes('409') || q.includes('tidak respon'))) {
    return `🤖 *Solusi Kendala Bot Telegram*\n\n` +
      `1. *Akses Ditolak:* masukkan Chat ID Anda ke \`telegram_admin_id\` di Pengaturan ➜ Telegram Bot (cek via @userinfobot).\n` +
      `2. *409 Conflict:* ada 2 proses bot dengan token sama — hentikan salah satu, lalu restart service.`;
  }

  if (q.includes('database is locked') || q.includes('sqlite_busy') || q.includes('restore')) {
    return `🗄️ *Solusi: Database Locked & Restore Backup*\n\n` +
      `1. *Locked:* WAL sudah aktif; jika stuck restart service (mis. \`pm2 restart\`).\n` +
      `2. *Restore:* file backup harian ada di folder \`backups/\`. Hentikan service, salin file backup ke DB aktif, lalu start kembali.`;
  }

  if (q.includes('digiflazz') && (q.includes('gagal') || q.includes('rc 40') || q.includes('rc 41') || q.includes('rc 42') || q.includes('saldo'))) {
    return `🏦 *Solusi Kendala Transaksi Digiflazz*\n\n` +
      `• *RC 40/41 (IP Not Allowed):* daftarkan IP publik server ke Whitelist IP di member area Digiflazz.\n` +
      `• *RC 42 (Saldo Kurang):* cek saldo via bot (\`saldodigi\`) lalu top up deposit.\n` +
      `• Cek status transaksi: \`cekpulsa <TXID>\`.`;
  }

  // Ringkasan fitur
  if (q.includes('isolir') || q.includes('putus') || q.includes('tunggak')) {
    return `🔒 *Fitur Auto Isolir & Unisolir*\n\n` +
      `• *Trigger:* cron otomatis saat pelanggan melewati tanggal jatuh tempo.\n` +
      `• *Metode MikroTik:* menambah IP ke address-list isolir atau mengubah IP pool ke pool isolir.\n` +
      `• *Radius:* memindahkan user ke profile isolir secara dinamis.\n` +
      `• *Unisolir otomatis:* begitu tagihan lunas (gateway/kolektor/admin), isolir langsung dicabut.`;
  }

  if (q.includes('genieacs') || q.includes('tr069') || q.includes('tr-069') || q.includes('onu')) {
    return `📡 *Fitur GenieACS & TR-069*\n\n` +
      `• *Auto Provisioning:* perangkat baru dikenali via Serial Number/Tag.\n` +
      `• *Monitoring:* redaman RX/TX, uptime, status WAN PPPoE, jumlah user WiFi.\n` +
      `• *Kontrol Jarak Jauh:* reboot ONU, ganti SSID, ganti sandi WiFi dari web admin atau bot.`;
  }

  if (q.includes('olt') || q.includes('snmp') || q.includes('gpon') || q.includes('epon')) {
    return `🔌 *Fitur OLT & ONU Management (SNMP)*\n\n` +
      `• Mendukung OLT EPON & GPON (HIOSO, VSOL, ZTE, dll).\n` +
      `• Memantau status port PON & uplink real-time via SNMP.\n` +
      `• Auto-discovery ONU belum terkonfigurasi untuk memudahkan teknisi.`;
  }

  if (q.includes('payment') || q.includes('ipaymu') || q.includes('qris') || q.includes('midtrans') || q.includes('xendit')) {
    return `💳 *Fitur Payment Gateway & Pembayaran*\n\n` +
      `• *Gateway:* iPaymu (QRIS dinamis), serta dukungan gateway HTTP/webhook kustom.\n` +
      `• *QRIS Statis + Kode Unik:* verifikasi otomatis dari notifikasi mutasi.\n` +
      `• Konfirmasi pembayaran otomatis mencabut isolir & mengirim notifikasi.`;
  }

  if (q.includes('whatsapp') || q.includes('baileys') || q.includes('notif')) {
    return `💬 *Fitur WhatsApp Gateway (Baileys)*\n\n` +
      `• Engine Baileys unofficial (tanpa biaya API berbayar).\n` +
      `• *Notifikasi otomatis:* tagihan baru, pengingat jatuh tempo, notifikasi isolir, ucapan terima kasih saat lunas.\n` +
      `• *Chatbot:* pelanggan bisa cek tagihan, status WiFi, ganti sandi, dan minta reboot via WhatsApp.`;
  }

  if (q.includes('mikrotik') || q.includes('router') || q.includes('pppoe') || q.includes('hotspot')) {
    return `⚙️ *Fitur Integrasi MikroTik*\n\n` +
      `• *Multi-Router:* banyak router dalam 1 dashboard.\n` +
      `• *PPPoE:* sinkronisasi secret, status online/offline, traffic live.\n` +
      `• *Hotspot & Voucher:* sinkronisasi profile Mikhmon, cetak voucher massal.\n` +
      `• *Auto Script:* generator script isolir & failover.`;
  }

  if (q.includes('portal') || q.includes('pelanggan') || q.includes('customer')) {
    return `📱 *Portal Pelanggan (Self-Service)*\n\n` +
      `• Cek tagihan tanpa login (via nomor HP).\n` +
      `• Riwayat pembayaran & unduh invoice.\n` +
      `• Ganti nama/sandi WiFi mandiri.\n` +
      `• Beli voucher hotspot & buat tiket gangguan.`;
  }

  return `🤖 *Asisten AI ${getSetting('company_header', 'ZenRadius')}*\n\n` +
    `Saya dapat membantu menjawab berbagai pertanyaan seputar aplikasi ini:\n` +
    `• *Billing & Invoicing:* auto invoice, promo/prorata, auto isolir & unisolir\n` +
    `• *MikroTik:* multi-router, PPPoE secret, hotspot & voucher\n` +
    `• *GenieACS (TR-069):* cek redaman, reboot ONU, ganti WiFi\n` +
    `• *OLT (SNMP):* monitoring port PON, uncfg ONU (EPON/GPON)\n` +
    `• *Payment:* iPaymu, QRIS dinamis/statis + kode unik\n` +
    `• *WhatsApp:* notifikasi otomatis, broadcast, chatbot AI\n` +
    `• *Portal Pelanggan:* self-service WiFi, cek tagihan, tiket support\n\n` +
    `_💡 Coba tanyakan spesifik, misal: "Bagaimana cara isolir otomatis?" atau "Apakah support multi router?"_`;
}

/**
 * Handler tanya jawab AI utama.
 * @param {{question:string, senderName?:string, customerContext?:object|null, isAdmin?:boolean, extraContext?:object}} params
 */
async function askAi({ question, senderName, customerContext = null, isAdmin = false, extraContext = {} }) {
  const cleanQ = String(question || '').trim();
  if (!cleanQ) {
    return 'Silakan ajukan pertanyaan seputar fitur aplikasi atau layanan internet Anda.';
  }

  let adminContext = null;
  if (isAdmin) {
    try {
      adminContext = await getAdminGlobalContext(cleanQ);
    } catch (err) {
      logger.error(`[AI] Gagal build admin context: ${err.message}`);
    }
  }

  // AI aktif bila gemini_api_key terisi DAN gemini_enabled tidak dimatikan eksplisit.
  const apiKey = String(getSetting('gemini_api_key', '') || '').trim();
  const aiEnabled = getSetting('gemini_enabled', true) !== false;

  if (apiKey && aiEnabled) {
    try {
      const aiReply = await callGeminiApi(apiKey, cleanQ, senderName || 'Member', customerContext, isAdmin, adminContext);

      if (aiReply && aiReply.type === 'function_call') {
        const toolResult = await executeAdminTool(aiReply.functionCall.name, aiReply.functionCall.args, extraContext);
        return toolResult;
      }
      if (aiReply && aiReply.type === 'text') {
        return aiReply.text;
      }
      return typeof aiReply === 'string' ? aiReply : (aiReply?.text || JSON.stringify(aiReply));
    } catch (err) {
      logger.error(`[AI] Gagal call Gemini API: ${err.message}. Menggunakan fallback jawaban lokal.`);
      return getOfflineAnswer(cleanQ, customerContext, isAdmin, adminContext);
    }
  }

  return getOfflineAnswer(cleanQ, customerContext, isAdmin, adminContext);
}

/**
 * Utilitas Diagnostik: Cek DNS via Cloudflare DoH.
 */
async function checkDns(domain, type = 'A') {
  try {
    const cleanDomain = String(domain || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
    if (!cleanDomain) return '❌ Sebutkan domain yang ingin dicek. Contoh: `/dns google.com`';
    const recType = String(type || 'A').toUpperCase();

    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(cleanDomain)}&type=${recType}`;
    const res = await axios.get(url, { headers: { Accept: 'application/dns-json' }, timeout: 7000 });

    const data = res.data;
    if (!data.Answer || data.Answer.length === 0) {
      return `🔍 *HASIL CEK DNS*\n\nTarget: \`${cleanDomain}\`\nRecord: *${recType}*\nStatus: ⚠️ Tidak ditemukan record ${recType}.`;
    }

    let out = `🌐 *HASIL CEK DNS (Cloudflare Resolver)*\n\n`;
    out += `Domain: \`${cleanDomain}\`\nRecord: *${recType}*\n\n*Data Jawaban:*\n`;
    data.Answer.forEach(ans => { out += `• \`${ans.data}\` (TTL: ${ans.TTL}s)\n`; });
    return out;
  } catch (err) {
    return `❌ Gagal melakukan lookup DNS: ${err.message}`;
  }
}

/**
 * Utilitas Diagnostik: Cek konektivitas / latensi host (HTTP head ping).
 */
async function checkPing(host) {
  try {
    let cleanHost = String(host || '').trim();
    if (!cleanHost) return '❌ Sebutkan host yang ingin dicek. Contoh: `/ping google.com`';
    if (!/^https?:\/\//i.test(cleanHost)) cleanHost = 'http://' + cleanHost;

    const startTime = Date.now();
    const res = await axios.head(cleanHost, { timeout: 8000, validateStatus: () => true });
    const latency = Date.now() - startTime;

    return `🏓 *HASIL PING / KONEKSI*\n\n` +
      `Target: \`${cleanHost}\`\n` +
      `Status: ✅ Terhubung (HTTP ${res.status})\n` +
      `Latensi: *${latency} ms*`;
  } catch (err) {
    return `❌ Gagal menghubungi \`${host}\`: ${err.message}`;
  }
}

module.exports = {
  askAi,
  checkDns,
  checkPing,
  getOfflineAnswer,
  getAdminGlobalContext
};
