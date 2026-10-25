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

/**
 * Produk yang mendekati/melewati tanggal kadaluarsa.
 * Pembanding memakai NOW_LOCAL() (waktu dinding zona aplikasi) agar konsisten
 * dengan kolom lain dan tidak bergeser saat zona OS berbeda dari zona aplikasi.
 */
function listExpiringProducts(days = 60) {
  return db.prepare(`
    SELECT p.*, c.name AS category_name,
           CAST(julianday(p.expiry_date) - julianday(NOW_LOCAL()) AS INTEGER) AS days_until_expiry
    FROM pos_products p
    LEFT JOIN pos_categories c ON p.category_id = c.id
    WHERE p.is_active = 1
      AND p.expiry_date IS NOT NULL AND p.expiry_date != ''
      AND p.expiry_date <= date(NOW_LOCAL(), '+' || ? || ' days')
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

/* ───────────────────────────── Impor / Ekspor produk ───────────────────────────── */

/** Bungkus satu nilai CSV: kutip bila mengandung koma, kutip, atau baris baru. */
function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = [
  'sku', 'nama', 'kategori', 'harga_modal', 'harga_jual',
  'stok', 'stok_minimum', 'kadaluarsa',
  'satuan', 'faktor_konversi', 'harga_jual_satuan', 'harga_grosir', 'grosir_min_qty'
];

/**
 * CSV produk untuk diunduh. Satu baris per satuan: produk dengan 3 satuan
 * menghasilkan 3 baris dengan SKU sama, sehingga impor ulang bisa menambah
 * satuan tanpa menghapus yang lain.
 */
function buildProductCsv() {
  const products = listProducts({});
  const rows = [CSV_HEADERS.join(',')];

  for (const p of products) {
    const units = (p.units || []).length
      ? p.units
      : [{ unit_name: p.unit || 'pcs', conversion_factor: 1, price_retail: p.price_retail, price_wholesale: 0, wholesale_min_qty: 0 }];

    for (const u of units) {
      // Harga modal & stok hanya ditulis pada satuan dasar agar tidak berulang.
      const isBase = Number(u.conversion_factor) === 1;
      rows.push([
        csvCell(p.sku || ''),
        csvCell(p.name),
        csvCell(p.category_name || ''),
        csvCell(Number(p.cost_price) || 0),
        csvCell(isBase ? (Number(p.price_retail) || 0) : ''),
        csvCell(isBase ? (Number(p.stock) || 0) : ''),
        csvCell(isBase ? (Number(p.min_stock) || 0) : ''),
        csvCell(isBase ? (p.expiry_date || '') : ''),
        csvCell(u.unit_name),
        csvCell(Number(u.conversion_factor) || 1),
        csvCell(Number(u.price_retail) || 0),
        csvCell(Number(u.price_wholesale) || 0),
        csvCell(Number(u.wholesale_min_qty) || 0)
      ].join(','));
    }
  }

  // BOM agar Excel di Windows membaca UTF-8 dengan benar.
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

/** Pecah satu baris CSV dengan dukungan tanda kutip ganda. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === ';') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Baca teks CSV menjadi daftar baris terstruktur.
 * Header opsional: bila baris pertama bukan angka, dianggap header dan dipetakan
 * berdasarkan nama kolom. Nama kolom juga menerima istilah Indonesia.
 */
function parseProductCsv(text) {
  const raw = String(text || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('Berkas CSV kosong.');

  const ALIAS = {
    sku: 'sku', kode: 'sku', barcode: 'sku', id: 'sku',
    nama: 'nama', name: 'nama', produk: 'nama',
    kategori: 'kategori', category: 'kategori',
    harga_modal: 'harga_modal', modal: 'harga_modal', cost: 'harga_modal', harga_beli: 'harga_modal', cost_price: 'harga_modal', cost_price_base: 'harga_modal',
    harga_jual: 'harga_jual', jual: 'harga_jual', price: 'harga_jual', price_retail: 'harga_jual',
    stok: 'stok', stock: 'stok', qty: 'stok',
    stok_minimum: 'stok_minimum', min_stock: 'stok_minimum', minimum: 'stok_minimum',
    kadaluarsa: 'kadaluarsa', expiry: 'kadaluarsa', expiry_date: 'kadaluarsa', expired: 'kadaluarsa',
    satuan: 'satuan', unit: 'satuan', unit_name: 'satuan',
    faktor_konversi: 'faktor_konversi', conversion_factor: 'faktor_konversi', konversi: 'faktor_konversi',
    harga_jual_satuan: 'harga_jual_satuan',
    harga_grosir: 'harga_grosir', price_wholesale: 'harga_grosir',
    grosir_min_qty: 'grosir_min_qty', wholesale_min_qty: 'grosir_min_qty'
  };

  const firstCells = parseCsvLine(lines[0]);
  const firstIsHeader = firstCells.some((c) => ALIAS[String(c || '').toLowerCase().trim()]);
  const header = firstIsHeader
    ? firstCells.map((c) => ALIAS[String(c || '').toLowerCase().trim()] || '')
    : CSV_HEADERS;
  const body = firstIsHeader ? lines.slice(1) : lines;

  const rows = [];
  for (const line of body) {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((key, i) => { if (key) row[key] = cells[i] ?? ''; });
    if (!header.length) continue;
    if (!String(row.nama || '').trim() && !String(row.sku || '').trim()) continue;
    rows.push(row);
  }

  if (!rows.length) throw new Error('Tidak ada baris produk yang bisa dibaca dari berkas ini.');
  return rows;
}

/**
 * Ubah teks angka pada CSV menjadi number.
 *
 * Mendukung format Indonesia ("1.234.567,89"), format Inggris
 * ("1,234,567.89"), dan angka polos. Pemisah ribuan wajib dibedakan dari
 * pemisah desimal: tanpa itu "62.000" terbaca 62 dan harga produk hasil impor
 * diam-diam menjadi jauh lebih murah dari seharusnya — kesalahan yang sangat
 * berbahaya pada aplikasi kasir.
 */
function parseMoneyCell(value) {
  let s = String(value == null ? '' : value).replace(/[^0-9.,-]/g, '').trim();
  if (!s) return 0;

  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    // Pemisah yang muncul terakhir adalah desimal, sisanya pemisah ribuan.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasDot) {
    // "62.000" & "1.234.567" = ribuan; "62.5" = desimal.
    s = /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s;
  } else if (hasComma) {
    // "62,000" = ribuan; "62,5" = desimal ala Indonesia.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/** Normalisasi tanggal dari CSV: 2026-01-31, 31/01/2026, 31-01-2026. */
function parseDateCell(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const d = String(m[1]).padStart(2, '0');
    const mo = String(m[2]).padStart(2, '0');
    return `${m[3]}-${mo}-${d}`;
  }
  return null;
}

/**
 * Impor produk dari baris CSV hasil parseProductCsv.
 * Beberapa baris dengan SKU sama digabung menjadi satu produk dengan banyak satuan.
 * mode: 'upsert' (perbarui produk yang ada) atau 'insert_only' (lewati yang ada).
 */
function importProducts(rows, mode = 'upsert', actor = 'Admin') {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) throw new Error('Daftar impor kosong.');

  // Gabungkan baris per SKU (atau per nama bila SKU kosong).
  const grouped = new Map();
  for (const r of list) {
    const name = String(r.nama || '').trim();
    const sku = String(r.sku || '').trim();
    if (!name && !sku) continue;
    const key = (sku || name).toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, {
        sku: sku || null,
        name: name || sku,
        category_name: String(r.kategori || '').trim(),
        cost_price: parseMoneyCell(r.harga_modal),
        price_retail: parseMoneyCell(r.harga_jual),
        stock: Math.round(parseMoneyCell(r.stok)),
        min_stock: Math.round(parseMoneyCell(r.stok_minimum)),
        expiry_date: parseDateCell(r.kadaluarsa),
        units: []
      });
    }
    const g = grouped.get(key);
    // Lengkapi nilai yang belum ada dari baris satuan berikutnya.
    if (!g.cost_price) g.cost_price = parseMoneyCell(r.harga_modal);
    if (!g.price_retail) g.price_retail = parseMoneyCell(r.harga_jual);
    if (!g.expiry_date) g.expiry_date = parseDateCell(r.kadaluarsa);

    const unitName = String(r.satuan || '').trim() || 'pcs';
    const factor = Math.max(1, Math.round(parseMoneyCell(r.faktor_konversi)) || 1);
    const unitRetail = parseMoneyCell(r.harga_jual_satuan) || parseMoneyCell(r.harga_jual) || g.price_retail;
    g.units.push({
      unit_name: unitName,
      conversion_factor: factor,
      price_retail: unitRetail,
      price_wholesale: parseMoneyCell(r.harga_grosir),
      wholesale_min_qty: Math.round(parseMoneyCell(r.grosir_min_qty))
    });
  }

  const findCat = db.prepare('SELECT id FROM pos_categories WHERE name = ? COLLATE NOCASE');
  const insertCat = db.prepare('INSERT INTO pos_categories (name) VALUES (?)');
  const findSku = db.prepare('SELECT id FROM pos_products WHERE sku = ?');

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const g of grouped.values()) {
      let categoryId = null;
      if (g.category_name) {
        const found = findCat.get(g.category_name);
        categoryId = found ? found.id : Number(insertCat.run(g.category_name).lastInsertRowid);
      }

      const existing = g.sku ? findSku.get(g.sku) : null;
      if (existing && String(mode).toLowerCase() === 'insert_only') { skipped++; continue; }

      // Pastikan selalu ada satuan dasar agar konversi stok konsisten.
      if (!g.units.some((u) => u.conversion_factor === 1)) {
        g.units.unshift({
          unit_name: g.units[0]?.unit_name || 'pcs',
          conversion_factor: 1,
          price_retail: g.units[0]?.price_retail || g.price_retail,
          price_wholesale: 0,
          wholesale_min_qty: 0
        });
      }

      if (existing) {
        db.prepare(`
          UPDATE pos_products SET name = ?, category_id = ?, cost_price = ?, price_retail = ?,
            min_stock = ?, expiry_date = ?, is_active = 1, updated_at = (NOW_LOCAL())
          WHERE id = ?
        `).run(g.name, categoryId, g.cost_price, g.price_retail, g.min_stock, g.expiry_date, existing.id);

        db.prepare('DELETE FROM pos_product_units WHERE product_id = ?').run(existing.id);
        const insertUnit = db.prepare(`
          INSERT INTO pos_product_units (product_id, unit_name, conversion_factor, price_retail, price_wholesale, wholesale_min_qty)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const u of g.units) {
          insertUnit.run(existing.id, u.unit_name, u.conversion_factor, u.price_retail, u.price_wholesale, u.wholesale_min_qty);
        }
        updated++;
      } else {
        const info = db.prepare(`
          INSERT INTO pos_products (sku, name, category_id, unit, cost_price, price_retail, stock, min_stock, expiry_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          g.sku, g.name, categoryId, g.units[0].unit_name,
          g.cost_price, g.price_retail, g.stock, g.min_stock, g.expiry_date
        );
        const productId = Number(info.lastInsertRowid);
        const insertUnit = db.prepare(`
          INSERT INTO pos_product_units (product_id, unit_name, conversion_factor, price_retail, price_wholesale, wholesale_min_qty)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const u of g.units) {
          insertUnit.run(productId, u.unit_name, u.conversion_factor, u.price_retail, u.price_wholesale, u.wholesale_min_qty);
        }
        if (g.stock !== 0) {
          logStock({
            productId, qtyChange: g.stock, stockAfter: g.stock,
            type: 'PURCHASE', reference: 'IMPOR CSV', actor
          });
        }
        inserted++;
      }
    }
  })();

  return { inserted, updated, skipped, total: grouped.size };
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  PAYMENT_TYPES,
  EXPENSE_CATEGORIES,
  buildProductCsv,
  parseProductCsv,
  importProducts,
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
