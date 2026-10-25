'use strict';
/**
 * Service: Point of Sale (Toko).
 *
 * Modul POS untuk penjualan barang ritel/grosir di panel admin ZenRadius.
 * Semua tabel memakai prefiks pos_ sehingga terpisah dari inventaris ISP
 * (inventory_*) dan data billing pelanggan.
 *
 * Prinsip:
 *  - Semua perubahan stok dan uang dibungkus transaksi better-sqlite3.
 *  - Harga modal disimpan per satuan dasar; profit dihitung saat checkout.
 *  - Setiap mutasi stok tercatat di pos_stock_logs sebagai audit trail.
 */
const db = require('../config/database');
const { getAppSetting, saveAppSetting } = db;

const SETTINGS_KEY = 'pos_settings';

/** Pengaturan default toko — brand mengikuti aplikasi, bisa dikustom dari UI. */
const DEFAULT_SETTINGS = {
  store_name: '',            // kosong = pakai nama perusahaan dari Pengaturan
  store_address: '',
  store_phone: '',
  receipt_footer: 'Terima kasih atas kunjungan Anda',
  receipt_show_logo: true,
  qris_static_payload: '',
  tax_percent: 0,
  loyalty_enabled: true,
  loyalty_spend_per_point: 10000,
  loyalty_point_value: 100,
  default_min_stock: 5,
  low_stock_alert: true
};

const PAYMENT_TYPES = ['CASH', 'QRIS', 'CREDIT'];
const EXPENSE_CATEGORIES = ['Operasional', 'Gaji', 'Sewa', 'Listrik & Air', 'Transport', 'Lain-lain'];

/* ───────────────────────────── Pengaturan ───────────────────────────── */

function getSettings() {
  const stored = getAppSetting(SETTINGS_KEY, null) || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

function saveSettings(patch) {
  const current = getSettings();
  const next = { ...current, ...patch };
  saveAppSetting(SETTINGS_KEY, next);
  return next;
}

/* ───────────────────────────── Kategori ───────────────────────────── */

function listCategories() {
  return db.prepare('SELECT * FROM pos_categories ORDER BY name ASC').all();
}

function createCategory({ name, description }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama kategori wajib diisi.');
  return db.prepare('INSERT INTO pos_categories (name, description) VALUES (?, ?)')
    .run(clean, String(description || '').trim());
}

function updateCategory(id, { name, description }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama kategori wajib diisi.');
  return db.prepare('UPDATE pos_categories SET name = ?, description = ? WHERE id = ?')
    .run(clean, String(description || '').trim(), id);
}

function deleteCategory(id) {
  return db.prepare('DELETE FROM pos_categories WHERE id = ?').run(id);
}

/* ───────────────────────────── Produk ───────────────────────────── */

/** Daftar produk beserta satuan konversinya. */
function listProducts({ search = '', categoryId = null, lowStockOnly = false } = {}) {
  let sql = `
    SELECT p.*, c.name AS category_name,
           (SELECT MIN(price_retail) FROM pos_product_units u WHERE u.product_id = p.id AND u.conversion_factor = 1) AS base_price
    FROM pos_products p
    LEFT JOIN pos_categories c ON p.category_id = c.id
    WHERE p.is_active = 1
  `;
  const params = [];

  if (search) {
    sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR c.name LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  if (categoryId) {
    sql += ' AND p.category_id = ?';
    params.push(categoryId);
  }
  if (lowStockOnly) {
    sql += ' AND p.stock <= p.min_stock';
  }
  sql += ' ORDER BY p.name ASC';

  const products = db.prepare(sql).all(...params);
  const unitStmt = db.prepare('SELECT * FROM pos_product_units WHERE product_id = ? ORDER BY conversion_factor ASC');
  return products.map((p) => ({ ...p, units: unitStmt.all(p.id) }));
}

function getProduct(id) {
  const product = db.prepare('SELECT * FROM pos_products WHERE id = ?').get(id);
  if (!product) return null;
  product.units = db.prepare('SELECT * FROM pos_product_units WHERE product_id = ? ORDER BY conversion_factor ASC').all(id);
  return product;
}

function findProductBySku(sku) {
  const clean = String(sku || '').trim();
  if (!clean) return null;
  const product = db.prepare('SELECT * FROM pos_products WHERE sku = ? AND is_active = 1').get(clean);
  if (!product) return null;
  product.units = db.prepare('SELECT * FROM pos_product_units WHERE product_id = ? ORDER BY conversion_factor ASC').all(product.id);
  return product;
}

/**
 * Simpan produk baru beserta satuannya.
 * Satuan dasar (conversion_factor = 1) wajib ada agar konversi stok konsisten.
 */
function createProduct(data) {
  const {
    sku, name, category_id, unit = 'pcs',
    cost_price = 0, price_retail = 0, stock = 0, min_stock = 0,
    expiry_date = null, units = []
  } = data;

  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Nama produk wajib diisi.');

  const cleanUnits = normalizeUnits(units, unit, price_retail, cost_price);

  return db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO pos_products (sku, name, category_id, unit, cost_price, price_retail, stock, min_stock, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(sku || '').trim() || null,
      cleanName,
      category_id || null,
      String(unit || 'pcs').trim(),
      toNumber(cost_price),
      toNumber(price_retail),
      toNumber(stock, true),
      toNumber(min_stock, true),
      expiry_date || null
    );

    const productId = Number(info.lastInsertRowid);
    const insertUnit = db.prepare(`
      INSERT INTO pos_product_units (product_id, unit_name, conversion_factor, price_retail, price_wholesale, wholesale_min_qty)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const u of cleanUnits) {
      insertUnit.run(productId, u.unit_name, u.conversion_factor, u.price_retail, u.price_wholesale, u.wholesale_min_qty);
    }

    // Stok awal tetap dicatat agar riwayatnya bisa diaudit.
    const openingStock = toNumber(stock, true);
    if (openingStock !== 0) {
      logStock({ productId, qtyChange: openingStock, stockAfter: openingStock, type: 'PURCHASE', reference: 'STOK AWAL', actor: data.actor || 'Admin' });
    }

    return productId;
  })();
}

function updateProduct(id, data) {
  const {
    sku, name, category_id, unit = 'pcs',
    cost_price = 0, price_retail = 0, min_stock = 0,
    expiry_date = null, units = []
  } = data;

  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Nama produk wajib diisi.');

  const cleanUnits = normalizeUnits(units, unit, price_retail, cost_price);

  return db.transaction(() => {
    db.prepare(`
      UPDATE pos_products
      SET sku = ?, name = ?, category_id = ?, unit = ?, cost_price = ?, price_retail = ?,
          min_stock = ?, expiry_date = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(
      String(sku || '').trim() || null,
      cleanName,
      category_id || null,
      String(unit || 'pcs').trim(),
      toNumber(cost_price),
      toNumber(price_retail),
      toNumber(min_stock, true),
      expiry_date || null,
      id
    );

    db.prepare('DELETE FROM pos_product_units WHERE product_id = ?').run(id);
    const insertUnit = db.prepare(`
      INSERT INTO pos_product_units (product_id, unit_name, conversion_factor, price_retail, price_wholesale, wholesale_min_qty)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const u of cleanUnits) {
      insertUnit.run(id, u.unit_name, u.conversion_factor, u.price_retail, u.price_wholesale, u.wholesale_min_qty);
    }
    return true;
  })();
}

function deleteProduct(id) {
  const used = db.prepare('SELECT COUNT(*) AS c FROM pos_sale_items WHERE product_id = ?').get(id);
  if (used && used.c > 0) {
    // Produk yang sudah pernah terjual dinonaktifkan agar riwayat nota tetap utuh.
    db.prepare('UPDATE pos_products SET is_active = 0, updated_at = (NOW_LOCAL()) WHERE id = ?').run(id);
    return { deactivated: true };
  }
  db.prepare('DELETE FROM pos_products WHERE id = ?').run(id);
  return { deactivated: false };
}

/** Penyesuaian stok manual (stock opname / koreksi). */
function adjustStock({ productId, qtyChange, note = '', actor = 'Admin' }) {
  const change = toNumber(qtyChange);
  if (!productId || change === 0) throw new Error('Produk dan jumlah perubahan wajib diisi.');

  return db.transaction(() => {
    const product = db.prepare('SELECT id, name, stock FROM pos_products WHERE id = ?').get(productId);
    if (!product) throw new Error('Produk tidak ditemukan.');

    const newStock = toNumber(product.stock, true) + change;
    if (newStock < 0) throw new Error('Penyesuaian akan menghasilkan stok negatif.');

    db.prepare('UPDATE pos_products SET stock = ?, updated_at = (NOW_LOCAL()) WHERE id = ?').run(newStock, productId);
    logStock({ productId, qtyChange: change, stockAfter: newStock, type: 'ADJUSTMENT', reference: note || 'Koreksi manual', actor });
    return newStock;
  })();
}

/** Produk yang mendekati/melewati tanggal kadaluarsa. */
function listExpiringProducts(days = 60) {
  return db.prepare(`
    SELECT p.*, c.name AS category_name,
           CAST(julianday(p.expiry_date) - julianday('now', 'localtime') AS INTEGER) AS days_until_expiry
    FROM pos_products p
    LEFT JOIN pos_categories c ON p.category_id = c.id
    WHERE p.is_active = 1
      AND p.expiry_date IS NOT NULL AND p.expiry_date != ''
      AND p.expiry_date <= date('now', 'localtime', '+' || ? || ' days')
    ORDER BY p.expiry_date ASC
  `).all(toNumber(days, true));
}

/* ───────────────────────────── Helper internal ───────────────────────────── */

function toNumber(value, asInt = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return asInt ? Math.round(n) : n;
}

/** Pastikan selalu ada satuan dasar (conversion_factor = 1). */
function normalizeUnits(units, baseUnit, basePrice, baseCost) {
  const list = Array.isArray(units) ? units : [];
  const cleaned = list
    .map((u) => ({
      unit_name: String(u.unit_name || '').trim(),
      conversion_factor: Math.max(1, toNumber(u.conversion_factor, true)),
      price_retail: toNumber(u.price_retail),
      price_wholesale: toNumber(u.price_wholesale),
      wholesale_min_qty: toNumber(u.wholesale_min_qty, true)
    }))
    .filter((u) => u.unit_name);

  if (!cleaned.some((u) => u.conversion_factor === 1)) {
    cleaned.unshift({
      unit_name: String(baseUnit || 'pcs').trim() || 'pcs',
      conversion_factor: 1,
      price_retail: toNumber(basePrice),
      price_wholesale: 0,
      wholesale_min_qty: 0
    });
  }
  // Harga modal hanya disimpan di level produk (per satuan dasar).
  void baseCost;
  return cleaned;
}

/** Catat mutasi stok ke audit trail. */
function logStock({ productId, qtyChange, stockAfter = null, type, reference = '', actor = '', note = '' }) {
  db.prepare(`
    INSERT INTO pos_stock_logs (product_id, qty_change, stock_after, type, reference, actor, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(productId, qtyChange, stockAfter, type, reference, actor, note);
}

function listStockLogs(limit = 100) {
  return db.prepare(`
    SELECT l.*, p.name AS product_name, p.unit AS product_unit
    FROM pos_stock_logs l
    LEFT JOIN pos_products p ON l.product_id = p.id
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ?
  `).all(toNumber(limit, true) || 100);
}

function listLowStock() {
  return db.prepare(`
    SELECT p.*, c.name AS category_name
    FROM pos_products p
    LEFT JOIN pos_categories c ON p.category_id = c.id
    WHERE p.is_active = 1 AND p.min_stock > 0 AND p.stock <= p.min_stock
    ORDER BY (p.stock - p.min_stock) ASC
  `).all();
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  PAYMENT_TYPES,
  EXPENSE_CATEGORIES,
  getSettings,
  saveSettings,

  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,

  listProducts,
  getProduct,
  findProductBySku,
  createProduct,
  updateProduct,
  deleteProduct,
  adjustStock,
  listExpiringProducts,
  listLowStock,
  listStockLogs,

  // internal yang dipakai modul POS lain
  toNumber,
  logStock
};
