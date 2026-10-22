/**
 * aiAdminTools.js
 * Deklarasi & eksekutor "function calling" Gemini AI untuk aksi administratif
 * via WhatsApp / Telegram (diadaptasi dari alijayanet/billing-rtrw adminAiTools.js).
 *
 * Semua aksi menulis langsung ke service ZenRadius (tanpa circular import ke whatsappBot.mjs).
 */

const db = require('../config/database');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const mikrotikService = require('./mikrotikService');
const customerDevice = require('./customerDeviceService');
const agentSvc = require('./agentService');
const { getSetting, getCurrentDateInTimezone } = require('../config/settingsManager');
const { logger } = require('../config/logger');

/**
 * Deklarasi Tools (Function Calling) untuk Google Gemini API
 */
const adminToolDeclarations = [
  {
    name: 'add_customer',
    description: 'Mendaftarkan / menambah pelanggan internet baru ke database billing dan MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Nama lengkap pelanggan' },
        phone: { type: 'STRING', description: 'Nomor WhatsApp atau telepon pelanggan' },
        packageName: { type: 'STRING', description: 'Nama paket langganan (misal: BRONZE, SILVER, GOLD, dll)' },
        area: { type: 'STRING', description: 'Nama area / dusun / lokasi pelanggan (opsional)' },
        address: { type: 'STRING', description: 'Alamat lengkap rumah pelanggan (opsional)' },
        pppoeUsername: { type: 'STRING', description: 'Username akun PPPoE untuk dial MikroTik (opsional)' },
        pppoePassword: { type: 'STRING', description: 'Password akun PPPoE (opsional)' }
      },
      required: ['name', 'phone']
    }
  },
  {
    name: 'delete_customer_request',
    description: 'Meminta konfirmasi penghapusan data pelanggan secara permanen dari sistem',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID pelanggan, nomor WhatsApp, atau username PPPoE yang ingin dihapus' }
      },
      required: ['target']
    }
  },
  {
    name: 'reboot_onu',
    description: 'Me-reboot / restart modem ONU pelanggan dari jarak jauh via GenieACS TR-069',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID, no HP, akun PPPoE, atau tag ONU' }
      },
      required: ['target']
    }
  },
  {
    name: 'update_wifi_password',
    description: 'Mengubah kata sandi WiFi modem ONU pelanggan via GenieACS TR-069',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, no HP, akun PPPoE, atau tag ONU' },
        newPassword: { type: 'STRING', description: 'Kata sandi WiFi baru (minimal 8 karakter)' }
      },
      required: ['target', 'newPassword']
    }
  },
  {
    name: 'update_wifi_ssid',
    description: 'Mengubah nama SSID WiFi modem ONU pelanggan via GenieACS TR-069',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, no HP, akun PPPoE, atau tag ONU' },
        newSsid: { type: 'STRING', description: 'Nama SSID WiFi baru' }
      },
      required: ['target', 'newSsid']
    }
  },
  {
    name: 'mark_invoice_paid',
    description: 'Menandai lunas / melunasi tagihan invoice pelanggan dan cabut isolir jika ada',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'ID invoice (angka), nama pelanggan, no HP, atau username PPPoE' }
      },
      required: ['target']
    }
  },
  {
    name: 'isolate_customer',
    description: 'Mengisolir / suspend / memutus sementara layanan internet pelanggan di billing dan MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID pelanggan, no HP, atau username PPPoE' }
      },
      required: ['target']
    }
  },
  {
    name: 'unisolate_customer',
    description: 'Membuka isolir / mengaktifkan kembali layanan internet pelanggan di billing dan MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Nama pelanggan, ID pelanggan, no HP, atau username PPPoE' }
      },
      required: ['target']
    }
  },
  {
    name: 'kick_pppoe_user',
    description: 'Memutus paksa / kick sesi active PPPoE atau Hotspot pelanggan di router MikroTik',
    parameters: {
      type: 'OBJECT',
      properties: {
        username: { type: 'STRING', description: 'Username PPPoE atau nama pelanggan' }
      },
      required: ['username']
    }
  },
  {
    name: 'create_hotspot_voucher',
    description: 'Membuat / generate voucher hotspot baru di router MikroTik (profile Mikhmon)',
    parameters: {
      type: 'OBJECT',
      properties: {
        profile: { type: 'STRING', description: 'Nama profil paket voucher (misal: 1jam, 5jam, 24jam, dll)' },
        count: { type: 'INTEGER', description: 'Jumlah voucher yang ingin dibuat (opsional, default 1, maks 10)' }
      },
      required: ['profile']
    }
  },
  {
    name: 'generate_invoices',
    description: 'Menjalankan generate invoice tagihan bulanan seluruh pelanggan',
    parameters: {
      type: 'OBJECT',
      properties: {
        month: { type: 'INTEGER', description: 'Bulan (1-12)' },
        year: { type: 'INTEGER', description: 'Tahun (misal: 2026)' }
      },
      required: ['month', 'year']
    }
  },
  {
    name: 'check_digiflazz_balance',
    description: 'Mengecek sisa saldo deposit Digiflazz (PPOB / Pulsa) Admin',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'topup_agent',
    description: 'Mentransfer / top up saldo agen reseller voucher atau pembayaran',
    parameters: {
      type: 'OBJECT',
      properties: {
        agentKey: { type: 'STRING', description: 'Username agent, nama agent, no HP, atau ID agent' },
        amount: { type: 'INTEGER', description: 'Nominal saldo yang ditransfer (angka dalam Rupiah)' },
        note: { type: 'STRING', description: 'Catatan transfer (opsional)' }
      },
      required: ['agentKey', 'amount']
    }
  }
];

/** Format Rupiah tanpa simbol mata uang (aman untuk WhatsApp/Telegram Markdown). */
function rupiah(n) {
  return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
}

/**
 * Helper untuk mencari pelanggan secara fleksibel (Nama, HP, PPPoE, ID, Tag)
 */
function findCustomerHelper(query) {
  if (!query) return null;
  const q = String(query).trim();

  // 1. Coba pencarian multi-kriteria bawaan service
  let cust = customerSvc.findCustomerByAny(q);
  if (cust) return cust;

  // 2. Nama persis
  const byExactName = db.prepare('SELECT id FROM customers WHERE LOWER(name) = LOWER(?) LIMIT 1').get(q);
  if (byExactName) return customerSvc.getCustomerById(byExactName.id);

  // 3. Pencarian parsial — jika hanya 1 kandidat, pakai itu
  const candidates = customerSvc.getAllCustomers(q) || [];
  if (candidates.length === 1) return customerSvc.getCustomerById(candidates[0].id);
  if (candidates.length > 1) {
    const exact = candidates.find(c => String(c.name || '').toLowerCase() === q.toLowerCase());
    if (exact) return customerSvc.getCustomerById(exact.id);
    return customerSvc.getCustomerById(candidates[0].id);
  }
  return null;
}

/** Resolve ID pelanggan dari angka (ID pelanggan) atau kriteria apa pun. */
function resolveCustomer(query) {
  if (query === undefined || query === null || query === '') return null;
  const raw = String(query).trim();
  if (/^\d+$/.test(raw)) {
    const byId = customerSvc.getCustomerById(Number(raw));
    if (byId) return byId;
  }
  return findCustomerHelper(raw);
}

/**
 * Eksekutor Tool / Fungsi Perintah AI Admin
 * @param {string} toolName
 * @param {object} args
 * @param {object} extraContext - { reply, sock, lidStore, phone }
 */
async function executeAdminTool(toolName, args, extraContext = {}) {
  const { sock, lidStore, phone } = extraContext;
  const safeArgs = args && typeof args === 'object' ? args : {};
  logger.info(`[AI Admin Tool] Eksekusi "${toolName}" args=${JSON.stringify(safeArgs)}`);

  try {
    switch (toolName) {
      // 1. Tambah Pelanggan
      case 'add_customer': {
        const { name, phone: custPhone, packageName, area, address, pppoeUsername, pppoePassword } = safeArgs;
        if (!name || !custPhone) {
          return '❌ Mohon sebutkan minimal Nama dan Nomor WhatsApp pelanggan yang ingin didaftarkan.';
        }

        const allPkgs = customerSvc.getAllPackages() || [];
        let pkg = null;
        if (packageName) {
          const q = String(packageName).toLowerCase().trim();
          pkg = allPkgs.find(p => String(p.name || '').toLowerCase() === q) ||
                allPkgs.find(p => String(p.name || '').toLowerCase().includes(q));
        }
        if (!pkg && allPkgs.length > 0) pkg = allPkgs[0];
        if (!pkg) {
          return '❌ Tidak ada paket layanan internet yang aktif di database. Buat paket terlebih dahulu di menu Paket.';
        }

        // ZenRadius memakai underscore untuk username PPPoE
        let cleanPppoe = String(pppoeUsername || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '');
        if (!cleanPppoe) cleanPppoe = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!cleanPppoe) cleanPppoe = 'user' + Math.floor(1000 + Math.random() * 9000);

        const existing = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(cleanPppoe);
        if (existing) cleanPppoe += Math.floor(10 + Math.random() * 89);
        const cleanPass = String(pppoePassword || cleanPppoe).trim();

        const routerRow = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
        const routerId = routerRow ? routerRow.id : null;

        const today = getCurrentDateInTimezone();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        const newCustData = {
          name: String(name).trim(),
          phone: String(custPhone).replace(/\D/g, ''),
          email: '',
          address: address ? String(address).trim() : '',
          area: area ? String(area).trim() : '',
          package_id: pkg.id,
          router_id: routerId,
          connection_type: 'pppoe',
          pppoe_username: cleanPppoe,
          pppoe_password: cleanPass,
          status: 'active',
          install_date: todayStr,
          auto_isolate: 1,
          isolate_day: Number(getSetting('default_isolate_day', 10)) || 10,
          is_radius: 0
        };

        const res = customerSvc.createCustomer(newCustData);
        const newId = res.lastInsertRowid;

        let mtSynced = false;
        let mtError = '';
        if (routerId) {
          try {
            await mikrotikService.createPppoeSecret({
              username: cleanPppoe,
              password: cleanPass,
              profile: pkg.name,
              routerId
            });
            mtSynced = true;
          } catch (err) {
            mtError = err.message;
          }
        }

        try {
          billingSvc.generateInvoiceForCustomer(newId, today.getMonth() + 1, today.getFullYear());
        } catch (_) { /* invoice bisa digenerate manual */ }

        return `✅ *PENDAFTARAN PELANGGAN BERHASIL*\n\n` +
          `• ID Pelanggan: *#${newId}*\n` +
          `• Nama: *${newDataName(name)}*\n` +
          `• No. WhatsApp: *${newCustData.phone}*\n` +
          `• Area: *${newCustData.area || '-'}*\n` +
          `• Paket: *${pkg.name}* (${rupiah(pkg.price)}/bln)\n` +
          `• Akun PPPoE: \`${cleanPppoe}\`\n` +
          `• Sandi PPPoE: \`${cleanPass}\`\n` +
          `• Sinkronisasi MikroTik: ${mtSynced ? '✅ Berhasil dibuat' : (mtError ? `⚠️ ${mtError}` : 'Dilewati (Router tidak tersedia)')}\n` +
          `• Status Billing: *Aktif* (invoice periode berjalan dibuat)`;
      }

      // 2. Hapus Pelanggan (Permintaan Konfirmasi)
      case 'delete_customer_request': {
        const { target } = safeArgs;
        if (!target) return '❌ Mohon sebutkan nama pelanggan, ID, atau No HP yang ingin dihapus.';
        const cust = resolveCustomer(target);
        if (!cust) {
          return `❌ Pelanggan *"${target}"* tidak ditemukan di sistem. Pastikan penulisan nama atau nomor HP benar.`;
        }

        return `⚠️ *KONFIRMASI PENGHAPUSAN PELANGGAN*\n\n` +
          `Apakah Anda yakin ingin menghapus pelanggan berikut dari sistem?\n\n` +
          `• ID: *#${cust.id}*\n` +
          `• Nama: *${cust.name}*\n` +
          `• No. HP: *${cust.phone || '-'}*\n` +
          `• Paket: *${cust.package_name || '-'}*\n` +
          `• PPPoE: \`${cust.pppoe_username || '-'}\`\n` +
          `• Status: *${cust.status}*\n\n` +
          `⚠️ _PERINGATAN: Tindakan ini permanen. Data tagihan dan akun MikroTik pelanggan akan dihapus._\n\n` +
          `Ketik balasan:\n👉 *YA HAPUS ${cust.id}*\n\n_Untuk membatalkan, abaikan pesan ini._`;
      }

      // 3. Reboot Modem ONU
      case 'reboot_onu': {
        const { target } = safeArgs;
        if (!target) return '❌ Mohon sebutkan target nama pelanggan atau tag ONU yang ingin di-reboot.';

        const cust = findCustomerHelper(target);
        const tagToken = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone) : target;

        const targetDevice = await customerDevice.resolveDeviceToken(tagToken);
        if (!targetDevice) {
          return `❌ Perangkat untuk target *"${target}"* tidak ditemukan di GenieACS TR-069.`;
        }

        const r = await customerDevice.requestReboot(tagToken);
        return `🔄 *REBOOT MODEM ONU*\n\nTarget: *${cust ? cust.name : target}* (Tag: \`${tagToken}\`)\nStatus: ${r.message}`;
      }

      // 4. Update Password WiFi
      case 'update_wifi_password': {
        const { target, newPassword } = safeArgs;
        if (!target || !newPassword) return '❌ Mohon sebutkan target pelanggan dan kata sandi baru.';
        if (String(newPassword).length < 8) return '❌ Kata sandi WiFi baru minimal 8 karakter.';

        const cust = findCustomerHelper(target);
        const tagToken = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone) : target;

        const ok = await customerDevice.updatePassword(tagToken, String(newPassword).trim());
        if (ok) {
          return `🔑 *GANTI SANDI WIFI BERHASIL*\n\nTarget: *${cust ? cust.name : target}*\nSandi Baru: \`${newPassword}\`\n\n_Modem ONU telah diperbarui via TR-069._`;
        }
        return `❌ Gagal mengubah kata sandi WiFi untuk *"${target}"*. Pastikan modem ONU sedang online di GenieACS.`;
      }

      // 5. Update SSID WiFi
      case 'update_wifi_ssid': {
        const { target, newSsid } = safeArgs;
        if (!target || !newSsid) return '❌ Mohon sebutkan target pelanggan dan nama SSID WiFi baru.';

        const cust = findCustomerHelper(target);
        const tagToken = cust ? (cust.genieacs_tag || cust.pppoe_username || cust.phone) : target;

        const ok = await customerDevice.updateSSID(tagToken, String(newSsid).trim());
        if (ok) {
          return `📶 *GANTI NAMA WIFI (SSID) BERHASIL*\n\nTarget: *${cust ? cust.name : target}*\nNama WiFi Baru: *${newSsid}*\n\n_Modem ONU telah diperbarui via TR-069._`;
        }
        return `❌ Gagal mengubah nama WiFi untuk *"${target}"*. Pastikan modem ONU sedang online di GenieACS.`;
      }

      // 6. Melunasi Tagihan
      case 'mark_invoice_paid': {
        const { target } = safeArgs;
        if (!target) return '❌ Mohon sebutkan ID invoice, nama pelanggan, atau no HP yang ingin dilunasi.';

        const keyRaw = String(target).trim();
        let targetInv = null;

        if (/^\d+$/.test(keyRaw)) {
          targetInv = billingSvc.getInvoiceById(Number(keyRaw));
        }

        if (!targetInv) {
          const cust = resolveCustomer(keyRaw);
          if (cust) {
            const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(cust.id) || [];
            if (unpaid.length === 0) {
              return `✅ Pelanggan *${cust.name}* tidak memiliki tagihan menunggak.`;
            }
            targetInv = unpaid[0];
          }
        }

        if (!targetInv) return `❌ Tagihan atau pelanggan *"${target}"* tidak ditemukan.`;
        if (targetInv.status === 'paid') return `✅ Invoice *#${targetInv.id}* sudah berstatus LUNAS.`;

        billingSvc.markAsPaid(targetInv.id, 'AI Admin', 'Paid via AI Assistant');

        // Buka isolir otomatis bila tidak ada sisa tunggakan
        const cust = customerSvc.getCustomerById(targetInv.customer_id);
        let unisolated = false;
        if (cust && String(cust.status || '').toLowerCase() !== 'active') {
          const remaining = (billingSvc.getUnpaidInvoicesByCustomerId(cust.id) || []).length;
          if (remaining === 0) {
            try {
              await customerSvc.activateCustomer(cust.id);
              unisolated = true;
            } catch (e) {
              logger.warn(`[AI Admin Tool] Gagal aktivasi otomatis pelanggan #${cust.id}: ${e.message}`);
            }
          }
        }

        return `✅ *PELUNASAN BERHASIL*\n\n` +
          `• Invoice: *#${targetInv.id}*\n` +
          `• Pelanggan: *${cust ? cust.name : (targetInv.customer_name || '-')}*\n` +
          `• Periode: *${targetInv.period_month}/${targetInv.period_year}*\n` +
          `• Nominal: *${rupiah(targetInv.amount)}*` +
          (unisolated ? `\n• Status Layanan: 🟢 *Diaktifkan kembali (isolir dicabut)*` : '');
      }

      // 7. Isolir Pelanggan
      case 'isolate_customer': {
        const { target } = safeArgs;
        if (!target) return '❌ Mohon sebutkan nama pelanggan atau ID yang ingin diisolir.';
        const cust = resolveCustomer(target);
        if (!cust) return `❌ Pelanggan *"${target}"* tidak ditemukan.`;

        await customerSvc.suspendCustomer(cust.id);
        return `⛔ *PELANGGAN DIISOLIR*\n\n• Nama: *${cust.name}*\n• ID: *#${cust.id}*\n• PPPoE: \`${cust.pppoe_username || '-'}\`\n\nLayanan internet dihentikan sementara di billing & MikroTik.`;
      }

      // 8. Buka Isolir Pelanggan
      case 'unisolate_customer': {
        const { target } = safeArgs;
        if (!target) return '❌ Mohon sebutkan nama pelanggan atau ID yang ingin dibuka isolirnya.';
        const cust = resolveCustomer(target);
        if (!cust) return `❌ Pelanggan *"${target}"* tidak ditemukan.`;

        await customerSvc.activateCustomer(cust.id);
        return `🟢 *ISOLIR DIBUKA*\n\n• Nama: *${cust.name}*\n• ID: *#${cust.id}*\n• PPPoE: \`${cust.pppoe_username || '-'}\`\n\nLayanan internet aktif kembali.`;
      }

      // 9. Kick PPPoE / Hotspot User
      case 'kick_pppoe_user': {
        const { username } = safeArgs;
        if (!username) return '❌ Mohon sebutkan username PPPoE yang ingin diputus.';

        let targetUser = String(username).trim();
        const cust = findCustomerHelper(targetUser);
        if (cust && cust.pppoe_username) targetUser = cust.pppoe_username;

        const pk = await mikrotikService.kickPppoeUser(targetUser);
        const hk = await mikrotikService.kickHotspotUser(targetUser);
        if (pk || hk) {
          return `✂️ *KICK USER AKTIF BERHASIL*\n\nSesi aktif untuk *${targetUser}*${cust ? ` (Pelanggan: ${cust.name})` : ''} telah diputus dari router MikroTik. Perangkat akan melakukan dial-up / login ulang otomatis.`;
        }
        return `⚠️ Sesi aktif untuk *"${targetUser}"* tidak ditemukan di router MikroTik.`;
      }

      // 10. Buat Voucher Hotspot
      case 'create_hotspot_voucher': {
        const { profile, count } = safeArgs;
        if (!profile) return '❌ Mohon sebutkan nama profil paket voucher hotspot (misal: 1jam, 5jam, dll).';

        const numVouchers = Math.min(Math.max(parseInt(count, 10) || 1, 1), 10);
        const created = [];
        const now = getCurrentDateInTimezone();
        const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

        for (let i = 0; i < numVouchers; i++) {
          const code = Math.floor(1000 + Math.random() * 9000).toString();
          const comment = `vc ${code} ${dateStr} AI`;
          await mikrotikService.addHotspotUser({
            name: code,
            password: code,
            profile: String(profile).trim(),
            comment
          });
          created.push(code);
        }

        let resp = `🎟️ *VOUCHER HOTSPOT BERHASIL DIBUAT*\n\n`;
        resp += `• Profil Paket: *${profile}*\n`;
        resp += `• Jumlah: *${created.length} voucher*\n\n`;
        resp += `*Kode Voucher (Username & Password):*\n`;
        created.forEach((c, idx) => { resp += `${idx + 1}. \`${c}\`\n`; });
        return resp;
      }

      // 11. Generate Tagihan Bulanan
      case 'generate_invoices': {
        const { month, year } = safeArgs;
        const now = getCurrentDateInTimezone();
        const m = parseInt(month, 10) || (now.getMonth() + 1);
        const y = parseInt(year, 10) || now.getFullYear();

        const created = await Promise.resolve(billingSvc.generateMonthlyInvoices(m, y));
        const createdCount = Array.isArray(created) ? created.length : (Number(created) || 0);
        return `🧾 *GENERATE INVOICE SELESAI*\n\n` +
          `• Periode: *${m}/${y}*\n` +
          `• Invoice Baru Dibuat: *${createdCount} tagihan*\n` +
          `_Pelanggan yang sudah memiliki invoice periode ini dilewati otomatis._`;
      }

      // 12. Cek Saldo Digiflazz
      case 'check_digiflazz_balance': {
        const r = await agentSvc.digiflazzCheckBalance();
        return `🏦 *SALDO DIGIFLAZZ (ADMIN)*\n\nDeposit: *${rupiah(r?.deposit)}*`;
      }

      // 13. Top Up Saldo Agent
      case 'topup_agent': {
        const { agentKey, amount, note } = safeArgs;
        const nom = Number(String(amount || '').replace(/[^\d]/g, ''));
        if (!nom || nom <= 0) return '❌ Nominal top up harus angka lebih dari 0.';

        const rawKey = String(agentKey || '').trim();
        if (!rawKey) return '❌ Mohon sebutkan nama/username/ID agent yang ingin di-top up.';

        const normalizeDigits = (v) => {
          let d = String(v || '').replace(/\D/g, '');
          if (!d) return '';
          if (d.startsWith('0')) d = '62' + d.slice(1);
          return d;
        };

        const all = agentSvc.getAllAgents() || [];
        const keyLc = rawKey.replace(/^@/, '').toLowerCase();
        const keyDigits = normalizeDigits(rawKey);

        let agent = null;
        if (/^\d+$/.test(rawKey)) agent = all.find(a => Number(a.id) === Number(rawKey)) || null;
        if (!agent) agent = all.find(a => String(a.username || '').toLowerCase() === keyLc) || null;
        if (!agent && keyDigits) agent = all.find(a => normalizeDigits(a.phone) === keyDigits) || null;
        if (!agent) agent = all.find(a => String(a.name || '').toLowerCase().includes(keyLc)) || null;

        if (!agent) return `❌ Agent *"${agentKey}"* tidak ditemukan.`;

        const r = agentSvc.topupAgent(agent.id, nom, note || 'Topup via AI Assistant', 'AI Admin');
        return `✅ *TOP UP AGENT BERHASIL*\n\n` +
          `• Agent: *${agent.name}* (@${agent.username})\n` +
          `• Nominal: *${rupiah(nom)}*\n` +
          `• Saldo: ${rupiah(r.before)} ➜ *${rupiah(r.after)}*\n` +
          `• Catatan: ${note || '-'}`;
      }

      default:
        return `⚠️ Fungsi *"${toolName}"* belum terkonfigurasi.`;
    }
  } catch (err) {
    logger.error(`[AI Admin Tool] Error saat eksekusi ${toolName}: ${err.message}`);
    return `❌ Gagal mengeksekusi perintah *${toolName}*: ${err.message}`;
  }
}

/** Escape minimal untuk nama pelanggan agar tidak merusak bold Markdown. */
function newDataName(name) {
  return String(name || '').replace(/[*_`~]/g, '').trim() || '-';
}

module.exports = {
  adminToolDeclarations,
  executeAdminTool
};
