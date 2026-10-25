'use strict';
/**
 * Route: Point of Sale (Toko) — diakses di /toko
 *
 * Modul POS untuk penjualan barang toko (ritel/grosir) di panel ZenRadius.
 * Semua route di sini hanya untuk admin & kasir, memakai sesi admin yang sama
 * dengan panel /admin sehingga tidak perlu login terpisah.
 *
 * Struktur:
 *   GET  /toko                 dashboard toko
 *   GET  /toko/kasir           layar kasir (POS)
 *   GET  /toko/produk          master produk & kategori
 *   GET  /toko/pembelian       stok masuk dari supplier
 *   GET  /toko/hutang          piutang pelanggan & hutang supplier
 *   GET  /toko/kas             buku kas & pengeluaran
 *   GET  /toko/shift           shift kasir (buka/tutup/settlement)
 *   GET  /toko/laporan         laporan penjualan & produk terlaris
 *   GET  /toko/pelanggan       pelanggan toko & poin loyalitas
 *   GET  /toko/pengaturan      pengaturan toko & struk
 *   GET  /toko/struk/:id       struk siap cetak
 *   API JSON di bawah /toko/api/*  (dipakai layar kasir)
 */
const express = require('express');
const router = express.Router();

const pos = require('../services/posService');
const txn = require('../services/posTransactionService');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const { getSetting, getSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const QRCode = require('qrcode');
const qrisUtil = require('../utils/qrisUtil');
const waSvc = require('../services/whatsappService');

const MENU_KEY = 'pos_toko';
const PAGE_TITLE = 'Point of Sale';

/**
 * Apakah permintaan mengharapkan balasan JSON?
 * Selain cek header dari klien, semua endpoint di bawah /toko/api/ selalu
 * dianggap permintaan API agar error tidak pernah dibalas dengan redirect HTML
 * (klien memanggil res.json() dan akan gagal parsing bila dibalas HTML).
 */
function wantsJson(req) {
  return Boolean(
    req.xhr
    || (req.get('accept') || '').includes('application/json')
    || String(req.originalUrl || req.url || '').includes('/api/')
  );
}

/* ───────────────────────────── Middleware ───────────────────────────── */

/** Sesi admin/kasir yang valid. Mengikuti aturan panel admin. */
function isAdminSession(s) {
  return s?.isAdmin === true || String(s?.role || '').trim().toLowerCase() === 'admin';
}

function isCashierSession(s) {
  return s?.isCashier === true || String(s?.role || '').trim().toLowerCase() === 'customer_service';
}

function requirePosSession(req, res, next) {
  const s = req.session || {};
  if (isAdminSession(s) || isCashierSession(s)) return next();
  return res.redirect('/admin/login');
}

/** Kasir dibatasi oleh pengaturan sidebar menu (sama seperti menu admin lain). */
function requirePosAccess(req, res, next) {
  const s = req.session || {};
  // Admin selalu lolos. Selain admin (termasuk kasir dengan role kanonik
  // customer_service tanpa flag isCashier) wajib diperiksa izin menunya.
  if (isAdminSession(s)) return next();
  try {
    const access = sidebarMenuSvc.evaluateMenuAccess(MENU_KEY, s);
    if (!access.allowed) {
      if (wantsJson(req)) {
        return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke menu ini.' });
      }
      req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke menu Point of Sale.' };
      return res.redirect('/admin');
    }
  } catch (_) { /* bila evaluasi gagal, jangan kunci admin */ }
  return next();
}

/** Hanya admin (untuk pengaturan, hapus, dan laporan sensitif). */
function requirePosAdmin(req, res, next) {
  const s = req.session || {};
  if (isAdminSession(s)) return next();
  if (wantsJson(req)) {
    return res.status(403).json({ success: false, message: 'Hanya Admin yang dapat melakukan aksi ini.' });
  }
  req.session._msg = { type: 'error', text: 'Hanya Admin yang dapat melakukan aksi ini.' };
  return res.redirect('/toko');
}

/**
 * Nama brand toko: pakai setelan toko bila diisi, jika kosong ikut nama
 * perusahaan pada Pengaturan (default: ZenRadius).
 */
function storeName() {
  const s = pos.getSettings();
  return String(s.store_name || '').trim() || company();
}

function company() {
  return String(getSetting('company_header', '') || '').trim() || 'ZenRadius';
}

/**
 * Payload QRIS yang dipakai modul toko.
 * Diutamakan setelan khusus toko (pos_settings.qris_static_payload); bila kosong
 * dipakai setelan QRIS Statis global ZenRadius agar merchant tidak perlu
 * mengisi dua kali.
 */
function resolveQrisPayload() {
  const own = String(pos.getSettings().qris_static_payload || '').trim();
  const raw = own || String(getSetting('qris_static_payload', '') || '').trim();
  if (!raw) return '';
  try {
    return qrisUtil.normalizeQrisPayload(raw);
  } catch (_) {
    return raw;
  }
}

router.use((req, res, next) => {
  const s = req.session || {};
  res.locals.session = s;
  res.locals.isMasterAdmin = Boolean(s.isMasterAdmin);
  res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(s);
  res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(s);
  res.locals.settings = getSettings();
  res.locals.company = company();
  res.locals.storeName = storeName();
  res.locals.menuKey = MENU_KEY;
  next();
});

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function setFlash(req, type, text) {
  req.session._msg = { type, text };
}

/** Bungkus handler async agar error tidak membuat proses menggantung. */
function wrap(fn, failRedirect = '/toko') {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') {
        out.catch((e) => {
          logger.error(`[POS] ${req.method} ${req.originalUrl}: ${e.message}`);
          if (wantsJson(req)) {
            return res.status(400).json({ success: false, message: e.message });
          }
          setFlash(req, 'error', e.message);
          return res.redirect(failRedirect);
        });
      }
    } catch (e) {
      logger.error(`[POS] ${req.method} ${req.originalUrl}: ${e.message}`);
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: e.message });
      }
      setFlash(req, 'error', e.message);
      return res.redirect(failRedirect);
    }
  };
}

/* ───────────────────────────── Halaman ───────────────────────────── */

router.get('/', requirePosSession, requirePosAccess, wrap((req, res) => {
  const stats = txn.getDashboardStats();
  const settings = pos.getSettings();
  const shift = txn.getActiveShift(req.session);
  res.render('toko/dashboard', {
    title: PAGE_TITLE,
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    stats,
    settings,
    shift: shift ? txn.getShiftSummary(shift) : null,
    formatMoney: txn.formatMoney
  });
}));

router.get('/kasir', requirePosSession, requirePosAccess, wrap((req, res) => {
  const products = pos.listProducts({});
  const categories = pos.listCategories();
  const customers = txn.listStoreCustomers('');
  const settings = pos.getSettings();
  const shift = txn.getActiveShift(req.session);
  // Produk cepat = yang paling laku pada 30 hari terakhir, untuk mempercepat
  // transaksi tanpa harus mengetik pencarian.
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const quickProducts = txn.getTopSelling({ startDate: since, limit: 8 })
    .map((p) => ({ id: p.id, name: p.name, sold_qty: Number(p.qty_sold || 0) }));
  res.render('toko/kasir', {
    title: 'Kasir',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    products,
    categories,
    customers,
    settings,
    shift: shift ? txn.getShiftSummary(shift) : null,
    quickProducts,
    formatMoney: txn.formatMoney
  });
}));

router.get('/produk', requirePosSession, requirePosAccess, wrap((req, res) => {
  const search = String(req.query.q || '').trim();
  const categoryId = req.query.category ? Number(req.query.category) : null;
  res.render('toko/produk', {
    title: 'Produk Toko',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    products: pos.listProducts({ search, categoryId, lowStockOnly: req.query.low === '1' }),
    categories: pos.listCategories(),
    stockLogs: pos.listStockLogs(50),
    expiring: pos.listExpiringProducts(60),
    search,
    categoryId,
    lowOnly: req.query.low === '1',
    settings: pos.getSettings(),
    formatMoney: txn.formatMoney
  });
}));

router.get('/pembelian', requirePosSession, requirePosAccess, wrap((req, res) => {
  res.render('toko/pembelian', {
    title: 'Pembelian Stok',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    purchases: txn.listPurchases({ search: String(req.query.q || '').trim() }),
    suppliers: txn.listSuppliers(),
    products: pos.listProducts({}),
    search: String(req.query.q || '').trim(),
    formatMoney: txn.formatMoney
  });
}));

router.get('/hutang', requirePosSession, requirePosAccess, wrap((req, res) => {
  res.render('toko/hutang', {
    title: 'Piutang & Hutang',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    customerDebts: txn.listCustomerDebts(),
    supplierDebts: txn.listSupplierDebts(),
    suppliers: txn.listSuppliers(),
    formatMoney: txn.formatMoney
  });
}));

router.get('/kas', requirePosSession, requirePosAccess, wrap((req, res) => {
  res.render('toko/kas', {
    title: 'Buku Kas Toko',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    expenses: txn.listExpenses({
      startDate: req.query.start || null,
      endDate: req.query.end || null,
      category: req.query.category || null
    }),
    categories: pos.EXPENSE_CATEGORIES,
    startDate: req.query.start || '',
    endDate: req.query.end || '',
    activeCategory: req.query.category || '',
    formatMoney: txn.formatMoney
  });
}));

router.get('/shift', requirePosSession, requirePosAccess, wrap((req, res) => {
  const shift = txn.getActiveShift(req.session);
  res.render('toko/shift', {
    title: 'Shift Kasir',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    activeShift: shift ? txn.getShiftSummary(shift) : null,
    shifts: txn.listShifts(req.session, 50),
    formatMoney: txn.formatMoney
  });
}));

router.get('/laporan', requirePosSession, requirePosAccess, wrap((req, res) => {
  const startDate = req.query.start || null;
  const endDate = req.query.end || null;
  res.render('toko/laporan', {
    title: 'Laporan Toko',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    report: txn.getSalesReport({ startDate, endDate }),
    topSelling: txn.getTopSelling({ startDate, endDate, limit: 20 }),
    slowMoving: txn.getSlowMovingProducts({ startDate, endDate, limit: 20 }),
    sales: txn.listSales({ startDate, endDate, limit: 100 }),
    startDate: startDate || '',
    endDate: endDate || '',
    formatMoney: txn.formatMoney
  });
}));

router.get('/pelanggan', requirePosSession, requirePosAccess, wrap((req, res) => {
  res.render('toko/pelanggan', {
    title: 'Pelanggan Toko',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    customers: txn.listStoreCustomers(String(req.query.q || '').trim()),
    search: String(req.query.q || '').trim(),
    settings: pos.getSettings(),
    formatMoney: txn.formatMoney
  });
}));

router.get('/pengaturan', requirePosSession, requirePosAdmin, wrap((req, res) => {
  res.render('toko/pengaturan', {
    title: 'Pengaturan Toko',
    company: company(),
    activePage: MENU_KEY,
    msg: flashMsg(req),
    posSettings: pos.getSettings(),
    defaults: pos.DEFAULT_SETTINGS,
    formatMoney: txn.formatMoney
  });
}));

/** Struk siap cetak — dipakai untuk printer thermal maupun cetak browser. */
router.get('/struk/:id', requirePosSession, requirePosAccess, wrap((req, res) => {
  const sale = txn.getSaleDetail(Number(req.params.id));
  if (!sale) {
    setFlash(req, 'error', 'Nota tidak ditemukan.');
    return res.redirect('/toko/laporan');
  }
  res.render('toko/struk', {
    title: `Struk ${sale.invoice_no}`,
    layout: false,
    sale,
    posSettings: pos.getSettings(),
    company: company(),
    formatMoney: txn.formatMoney
  });
}));

/**
 * Ekspor seluruh produk ke CSV.
 * Satu baris per satuan (sama seperti format impor) supaya berkas hasil ekspor
 * bisa langsung disunting lalu diimpor kembali tanpa konversi manual.
 */
router.get('/produk/export.csv', requirePosSession, requirePosAccess, wrap((req, res) => {
  const csv = pos.buildProductCsv();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="produk-toko-${stamp}.csv"`);
  // buildProductCsv() sudah menyertakan BOM UTF-8 untuk Excel.
  res.send(csv);
}, '/toko/produk'));

/** Impor produk dari berkas CSV (tempel teks atau unggah berkas). */
router.post('/produk/import', requirePosSession, requirePosAdmin,
  express.urlencoded({ extended: true, limit: '8mb' }), wrap((req, res) => {
    const body = req.body || {};
    const text = String(body.csv_text || '');
    if (!text.trim()) throw new Error('Isi data CSV terlebih dahulu.');

    const rows = pos.parseProductCsv(text);
    // insert_only = jangan sentuh produk yang sudah ada.
    const mode = String(body.mode || 'upsert').toLowerCase() === 'insert_only' ? 'insert_only' : 'upsert';
    const result = pos.importProducts(rows, mode, txn.actorName(req.session, 'Admin'));

    setFlash(req, 'success',
      `Impor selesai: ${result.inserted} produk baru, ${result.updated} diperbarui, ${result.skipped} dilewati.`);
    res.redirect('/toko/produk');
  }, '/toko/produk'));

/* ───────────────────────────── Aksi form (POST) ───────────────────────────── */

router.post('/produk/simpan', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  const body = req.body || {};
  const units = [];
  const names = [].concat(body.unit_name || []);
  const factors = [].concat(body.unit_factor || []);
  const retails = [].concat(body.unit_price || []);
  const wholesales = [].concat(body.unit_wholesale || []);
  const wholesaleMins = [].concat(body.unit_wholesale_min || []);
  for (let i = 0; i < names.length; i++) {
    if (!String(names[i] || '').trim()) continue;
    units.push({
      unit_name: names[i],
      conversion_factor: factors[i],
      price_retail: retails[i],
      price_wholesale: wholesales[i],
      wholesale_min_qty: wholesaleMins[i]
    });
  }

  const payload = {
    sku: body.sku,
    name: body.name,
    category_id: body.category_id ? Number(body.category_id) : null,
    unit: body.unit,
    cost_price: body.cost_price,
    price_retail: body.price_retail,
    min_stock: body.min_stock,
    expiry_date: body.expiry_date || null,
    units,
    actor: txn.actorName(req.session)
  };

  if (body.id) {
    pos.updateProduct(Number(body.id), payload);
    setFlash(req, 'success', 'Produk berhasil diperbarui.');
  } else {
    payload.stock = body.stock;
    pos.createProduct(payload);
    setFlash(req, 'success', 'Produk baru berhasil ditambahkan.');
  }
  res.redirect('/toko/produk');
}, '/toko/produk'));

router.post('/produk/hapus', requirePosSession, requirePosAdmin, express.urlencoded({ extended: true }), wrap((req, res) => {
  const result = pos.deleteProduct(Number(req.body.id));
  setFlash(req, 'success', result.deactivated
    ? 'Produk sudah pernah terjual, jadi dinonaktifkan (riwayat nota tetap utuh).'
    : 'Produk berhasil dihapus.');
  res.redirect('/toko/produk');
}, '/toko/produk'));

router.post('/produk/stok', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  pos.adjustStock({
    productId: Number(req.body.product_id),
    qtyChange: req.body.qty_change,
    note: req.body.note,
    actor: txn.actorName(req.session)
  });
  setFlash(req, 'success', 'Stok berhasil disesuaikan.');
  res.redirect('/toko/produk');
}, '/toko/produk'));

router.post('/kategori/simpan', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  if (req.body.id) pos.updateCategory(Number(req.body.id), req.body);
  else pos.createCategory(req.body);
  setFlash(req, 'success', 'Kategori tersimpan.');
  res.redirect('/toko/produk');
}, '/toko/produk'));

router.post('/kategori/hapus', requirePosSession, requirePosAdmin, express.urlencoded({ extended: true }), wrap((req, res) => {
  pos.deleteCategory(Number(req.body.id));
  setFlash(req, 'success', 'Kategori dihapus.');
  res.redirect('/toko/produk');
}, '/toko/produk'));

router.post('/supplier/simpan', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  if (req.body.id) txn.updateSupplier(Number(req.body.id), req.body);
  else txn.createSupplier(req.body);
  setFlash(req, 'success', 'Supplier tersimpan.');
  res.redirect('/toko/pembelian');
}, '/toko/pembelian'));

router.post('/pelanggan/simpan', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  if (req.body.id) txn.updateStoreCustomer(Number(req.body.id), req.body);
  else txn.createStoreCustomer(req.body);
  setFlash(req, 'success', 'Pelanggan tersimpan.');
  res.redirect('/toko/pelanggan');
}, '/toko/pelanggan'));

router.post('/pelanggan/poin', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  const next = txn.adjustCustomerPoints({
    customerId: Number(req.body.customer_id),
    pointsChange: req.body.points_change,
    reason: req.body.reason
  }, req.session);
  setFlash(req, 'success', `Poin pelanggan kini ${next}.`);
  res.redirect('/toko/pelanggan');
}, '/toko/pelanggan'));

router.post('/kas/simpan', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  txn.createExpense(req.body, req.session);
  setFlash(req, 'success', 'Pengeluaran tercatat.');
  res.redirect('/toko/kas');
}, '/toko/kas'));

router.post('/kas/hapus', requirePosSession, requirePosAdmin, express.urlencoded({ extended: true }), wrap((req, res) => {
  txn.deleteExpense(Number(req.body.id));
  setFlash(req, 'success', 'Pengeluaran dihapus.');
  res.redirect('/toko/kas');
}, '/toko/kas'));

router.post('/hutang/pelanggan', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  const r = txn.payCustomerDebt({
    saleId: Number(req.body.sale_id),
    amount: req.body.amount,
    note: req.body.note
  }, req.session);
  setFlash(req, 'success', `Pembayaran ${r.invoiceNo} diterima. Sisa piutang: Rp ${txn.formatMoney(r.balance)}.`);
  res.redirect('/toko/hutang');
}, '/toko/hutang'));

router.post('/hutang/supplier', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  const r = txn.paySupplierDebt({
    purchaseId: Number(req.body.purchase_id),
    amount: req.body.amount,
    note: req.body.note
  }, req.session);
  setFlash(req, 'success', `Pembayaran ${r.purchaseNo} dicatat. Sisa hutang: Rp ${txn.formatMoney(r.balance)}.`);
  res.redirect('/toko/hutang');
}, '/toko/hutang'));

router.post('/pembelian/simpan', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  const body = req.body || {};
  const productIds = [].concat(body.item_product || []);
  const qtys = [].concat(body.item_qty || []);
  const costs = [].concat(body.item_cost || []);
  const factors = [].concat(body.item_factor || []);
  const expiries = [].concat(body.item_expiry || []);

  const items = [];
  for (let i = 0; i < productIds.length; i++) {
    if (!productIds[i]) continue;
    items.push({
      product_id: Number(productIds[i]),
      qty: qtys[i],
      cost_price: costs[i],
      conversion_factor: factors[i] || 1,
      expiry_date: expiries[i] || null
    });
  }

  const r = txn.createPurchase({
    supplier_id: body.supplier_id ? Number(body.supplier_id) : null,
    payment_type: body.payment_type,
    cash_paid: body.cash_paid,
    due_date: body.due_date || null,
    note: body.note,
    items
  }, req.session);

  setFlash(req, 'success', `Pembelian ${r.purchaseNo} tersimpan (total Rp ${txn.formatMoney(r.total)}). Stok sudah bertambah.`);
  res.redirect('/toko/pembelian');
}, '/toko/pembelian'));

router.post('/pengaturan/simpan', requirePosSession, requirePosAdmin, express.urlencoded({ extended: true }), wrap((req, res) => {
  const body = req.body || {};
  pos.saveSettings({
    store_name: body.store_name,
    store_address: body.store_address,
    store_phone: body.store_phone,
    receipt_footer: body.receipt_footer,
    receipt_show_logo: body.receipt_show_logo === '1',
    qris_static_payload: body.qris_static_payload,
    tax_percent: body.tax_percent,
    loyalty_enabled: body.loyalty_enabled === '1',
    loyalty_spend_per_point: body.loyalty_spend_per_point,
    loyalty_point_value: body.loyalty_point_value,
    default_min_stock: body.default_min_stock,
    low_stock_alert: body.low_stock_alert === '1'
  });
  setFlash(req, 'success', 'Pengaturan toko tersimpan.');
  res.redirect('/toko/pengaturan');
}, '/toko/pengaturan'));

router.post('/shift/buka', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  txn.openShift(req.body, req.session);
  setFlash(req, 'success', 'Shift kasir dibuka.');
  res.redirect('/toko/shift');
}, '/toko/shift'));

router.post('/shift/tutup', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  const r = txn.closeShift(req.body, req.session);
  const diff = Number(r.difference || 0);
  const note = diff === 0 ? 'Kas sesuai.' : (diff > 0 ? `Kas lebih Rp ${txn.formatMoney(diff)}.` : `Kas kurang Rp ${txn.formatMoney(Math.abs(diff))}.`);
  setFlash(req, 'success', `Shift ditutup. ${note}`);
  res.redirect('/toko/shift');
}, '/toko/shift'));

router.post('/penjualan/void', requirePosSession, requirePosAdmin, express.urlencoded({ extended: true }), wrap((req, res) => {
  const r = txn.voidSale(Number(req.body.sale_id), req.session);
  setFlash(req, 'success', `Nota ${r.invoiceNo} dibatalkan dan stok dikembalikan.`);
  res.redirect('/toko/laporan');
}, '/toko/laporan'));

/**
 * Kirim ringkasan struk ke WhatsApp pelanggan.
 * Memakai gateway WhatsApp ZenRadius (Baileys / Fonnte / Wablas / Meta), jadi
 * tidak perlu konfigurasi tambahan khusus modul toko.
 */
router.post('/penjualan/kirim-wa', requirePosSession, requirePosAccess,
  express.urlencoded({ extended: true }), wrap(async (req, res) => {
    const saleId = Number(req.body.sale_id);
    const detail = txn.getSaleDetail(saleId);
    if (!detail) throw new Error('Nota tidak ditemukan.');

    // Nomor bisa diisi manual (pelanggan umum) atau diambil dari data pelanggan.
    const manual = String(req.body.phone || '').replace(/\D/g, '');
    const customer = detail.customer_id ? txn.getCustomer(detail.customer_id) : null;
    const phone = manual || String(customer?.phone || '').replace(/\D/g, '');
    if (!phone) throw new Error('Nomor WhatsApp pelanggan belum ada. Isi manual atau lengkapi data pelanggan.');

    const settings = pos.getSettings();
    const lines = (detail.items || []).map((i) =>
      `- ${i.qty} ${i.unit_name} ${i.product_name} = Rp ${txn.formatMoney(i.subtotal)}`
    ).join('\n');

    const message = [
      `*${storeName()}*`,
      `Nota: ${detail.invoice_no}`,
      `Tanggal: ${new Date(detail.sale_date).toLocaleString('id-ID')}`,
      '',
      lines,
      '',
      `Total: Rp ${txn.formatMoney(detail.total_amount)}`,
      `Bayar: ${detail.payment_type}`,
      Number(detail.change_amount) > 0 ? `Kembali: Rp ${txn.formatMoney(detail.change_amount)}` : '',
      Number(detail.debt_balance) > 0 ? `Sisa hutang: Rp ${txn.formatMoney(detail.debt_balance)}` : '',
      '',
      settings.receipt_footer || ''
    ].filter((l) => l !== '').join('\n');

    await waSvc.sendWhatsAppMessage(phone, message);
    setFlash(req, 'success', `Struk ${detail.invoice_no} dikirim ke WhatsApp ${phone}.`);
    res.redirect('/toko/laporan');
  }, '/toko/laporan'));

router.post('/penjualan/retur', requirePosSession, requirePosAccess, express.urlencoded({ extended: true }), wrap((req, res) => {
  const r = txn.refundSaleItem({
    saleId: Number(req.body.sale_id),
    saleItemId: Number(req.body.sale_item_id),
    qty: req.body.qty,
    reason: req.body.reason,
    refund_method: req.body.refund_method
  }, req.session);
  setFlash(req, 'success', r.refundMethod === 'DEBT_DEDUCTION'
    ? `Retur tercatat: Rp ${txn.formatMoney(r.amount)} dari piutang pelanggan. Stok dikembalikan.`
    : `Retur tercatat: Rp ${txn.formatMoney(r.amount)} dibayar tunai (tercatat di buku kas). Stok dikembalikan.`);
  res.redirect('/toko/laporan');
}, '/toko/laporan'));

/* ───────────────────────────── API JSON (layar kasir) ───────────────────────────── */

router.get('/api/produk', requirePosSession, requirePosAccess, wrap((req, res) => {
  const search = String(req.query.q || '').trim();
  const product = search ? pos.findProductBySku(search) : null;
  if (product) return res.json({ success: true, data: [product], exact: true });
  return res.json({ success: true, data: pos.listProducts({ search }), exact: false });
}));

router.get('/api/pelanggan', requirePosSession, requirePosAccess, wrap((req, res) => {
  res.json({ success: true, data: txn.listStoreCustomers(String(req.query.q || '').trim()) });
}));

/** Riwayat mutasi poin seorang pelanggan toko. */
router.get('/api/pelanggan/:id/poin', requirePosSession, requirePosAccess, wrap((req, res) => {
  res.json({ success: true, data: txn.listPointLogs(Number(req.params.id), 100) });
}));

router.post('/api/checkout', requirePosSession, requirePosAccess, express.json(), wrap((req, res) => {
  const result = txn.checkout(req.body || {}, req.session);
  res.json({ success: true, data: result });
}, '/toko/kasir'));

/**
 * QRIS dinamis untuk layar kasir.
 * Mengubah QRIS statis merchant (setelan toko atau setelan global) menjadi
 * QRIS dinamis bernominal pasti, supaya pelanggan tidak perlu mengetik ulang.
 */
router.get('/api/qris', requirePosSession, requirePosAccess, wrap(async (req, res) => {
  const amount = Math.round(Number(req.query.amount || 0));
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Nominal QRIS tidak valid.' });
  }

  const payload = resolveQrisPayload();
  if (!payload) {
    return res.status(400).json({
      success: false,
      message: 'QRIS Statis belum diatur. Isi di Pengaturan Toko atau Pengaturan QRIS ZenRadius.'
    });
  }

  try {
    const dynamic = qrisUtil.convertStaticQrisToDynamic(payload, amount);
    // QR dibuat di server agar layar kasir tidak perlu memuat pustaka QR.
    const qr = await QRCode.toDataURL(dynamic, {
      errorCorrectionLevel: 'M', margin: 1, width: 320
    });
    return res.json({ success: true, data: { amount, qr, dynamic: true } });
  } catch (e) {
    logger.error(`[POS] QRIS dinamis gagal: ${e.message}`);
    // Payload tidak bisa dikonversi: pakai gambar QRIS statis sebagai cadangan
    // agar kasir tetap bisa meminta pelanggan membayar tanpa nominal otomatis.
    const fallback = String(getSetting('qris_static_qr_url', '') || '').trim();
    if (fallback) {
      return res.json({
        success: true,
        data: { amount, qr: fallback, dynamic: false, fallback: true }
      });
    }
    return res.status(400).json({ success: false, message: 'QRIS Statis tidak valid.' });
  }
}, '/toko/kasir'));

router.post('/api/hold', requirePosSession, requirePosAccess, express.json(), wrap((req, res) => {
  const id = txn.holdCart({ label: req.body?.label, payload: req.body?.payload }, req.session);
  res.json({ success: true, id });
}, '/toko/kasir'));

router.get('/api/hold', requirePosSession, requirePosAccess, wrap((req, res) => {
  res.json({ success: true, data: txn.listHeldCarts(req.session) });
}));

router.delete('/api/hold/:id', requirePosSession, requirePosAccess, wrap((req, res) => {
  txn.deleteHeldCart(Number(req.params.id));
  res.json({ success: true });
}));

router.get('/api/shift', requirePosSession, requirePosAccess, wrap((req, res) => {
  const shift = txn.getActiveShift(req.session);
  res.json({ success: true, data: shift ? txn.getShiftSummary(shift) : null });
}));

router.get('/api/riwayat/:id', requirePosSession, requirePosAccess, wrap((req, res) => {
  const sale = txn.getSaleDetail(Number(req.params.id));
  if (!sale) return res.status(404).json({ success: false, message: 'Nota tidak ditemukan.' });
  res.json({ success: true, data: sale });
}));

module.exports = router;
module.exports.MENU_KEY = MENU_KEY;
