'use strict';
/**
 * Service: transaksi Point of Sale (Toko).
 *
 * Menangani alur uang dan stok: checkout penjualan, void, retur, pembelian
 * supplier, piutang/hutang, buku kas, shift kasir, loyalitas poin, dan laporan.
 *
 * Semua operasi yang menyentuh stok/uang dibungkus db.transaction() agar tidak
 * ada kondisi setengah jadi bila terjadi error di tengah proses.
 */
const db = require('../config/database');
const pos = require('./posService');
const { getSetting } = require('../config/settingsManager');

const { toNumber, logStock } = pos;

/* ───────────────────────────── Helper ───────────────────────────── */

function actorName(session, fallback = 'Admin') {
  if (!session) return fallback;
  if (session.isCashier) {
    const nm = String(session.cashierName || '').trim();
    const un = String(session.cashierUsername || '').trim();
    if (nm && un) return `Kasir ${nm} (@${un})`;
    if (nm) return `Kasir ${nm}`;
    return 'Kasir';
  }
  return String(session.adminName || session.username || fallback).trim() || fallback;
}

function currentCashierId(session) {
  if (!session) return null;
  const id = session.cashierId ?? session.adminId ?? null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

/** Nomor dokumen berurutan per hari: INV-YYYYMMDD-0001 */
function generateDocNumber(prefix, table, dateColumn) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM ${table} WHERE date(${dateColumn}, 'localtime') = date('now', 'localtime')`
  ).get();
  const seq = String((row?.c || 0) + 1).padStart(4, '0');
  return `${prefix}-${stamp}-${seq}`;
}

function getCustomer(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM pos_customers WHERE id = ?').get(id) || null;
}

/* ───────────────────────────── Checkout penjualan ───────────────────────────── */

/**
 * Simpan transaksi penjualan.
 *
 * items: [{ product_id, unit_id, qty }]
 * Harga diambil dari satuan terpilih (grosir bila qty memenuhi syarat).
 * Mendukung pembayaran CASH / QRIS / CREDIT (tempo) dan tukar poin.
 */
function checkout(payload, session) {
  const {
    customer_id = null,
    payment_type = 'CASH',
    cash_amount = 0,
    discount_amount = 0,
    redeem_points = 0,
    due_date = null,
    note = '',
    items = []
  } = payload || {};

  const type = String(payment_type).toUpperCase();
  if (!pos.PAYMENT_TYPES.includes(type)) throw new Error(`Metode pembayaran tidak dikenal: ${payment_type}`);
  if (!Array.isArray(items) || items.length === 0) throw new Error('Keranjang masih kosong.');

  const settings = pos.getSettings();
  const actor = actorName(session, 'Admin');

  return db.transaction(() => {
    const invoiceNo = generateDocNumber('INV', 'pos_sales', 'sale_date');

    let subtotal = 0;
    let totalProfit = 0;
    const lines = [];

    for (const raw of items) {
      const product = db.prepare('SELECT * FROM pos_products WHERE id = ? AND is_active = 1').get(raw.product_id);
      if (!product) throw new Error(`Produk tidak ditemukan (id ${raw.product_id}).`);

      const qty = toNumber(raw.qty);
      if (qty <= 0) throw new Error(`Jumlah tidak valid untuk ${product.name}.`);

      const unit = raw.unit_id
        ? db.prepare('SELECT * FROM pos_product_units WHERE id = ? AND product_id = ?').get(raw.unit_id, product.id)
        : db.prepare('SELECT * FROM pos_product_units WHERE product_id = ? ORDER BY conversion_factor ASC LIMIT 1').get(product.id);
      if (!unit) throw new Error(`Satuan tidak valid untuk ${product.name}.`);

      const factor = Math.max(1, toNumber(unit.conversion_factor, true));
      const qtyBase = qty * factor;

      if (toNumber(product.stock, true) < qtyBase) {
        throw new Error(`Stok ${product.name} tidak cukup (tersedia ${product.stock}, butuh ${qtyBase}).`);
      }

      // Harga grosir dipakai bila qty memenuhi ambang minimum.
      let priceUsed = toNumber(unit.price_retail) || toNumber(product.price_retail);
      const wholesaleMin = toNumber(unit.wholesale_min_qty, true);
      if (wholesaleMin > 0 && qty >= wholesaleMin && toNumber(unit.price_wholesale) > 0) {
        priceUsed = toNumber(unit.price_wholesale);
      }

      const lineSubtotal = priceUsed * qty;
      const lineCost = toNumber(product.cost_price) * qtyBase;
      const lineProfit = lineSubtotal - lineCost;

      subtotal += lineSubtotal;
      totalProfit += lineProfit;
      lines.push({
        product, unit, qty, factor, qtyBase,
        priceUsed, lineSubtotal, lineCost, lineProfit
      });
    }

    /* ── Loyalitas: tukar poin jadi diskon ── */
    let pointsDiscount = 0;
    let customer = null;
    let pointsRedeemed = 0;

    if (customer_id) customer = getCustomer(customer_id);

    const redeem = toNumber(redeem_points, true);
    if (redeem > 0) {
      if (!customer) throw new Error('Tukar poin memerlukan pelanggan yang terdaftar.');
      if (!settings.loyalty_enabled) throw new Error('Program poin sedang tidak aktif.');
      if (redeem > toNumber(customer.points, true)) {
        throw new Error(`Poin pelanggan tidak cukup (tersedia ${customer.points}).`);
      }
      pointsDiscount = redeem * toNumber(settings.loyalty_point_value, true);
      if (pointsDiscount > subtotal) pointsDiscount = subtotal;
      pointsRedeemed = redeem;
    }

    const discount = toNumber(discount_amount);
    let total = subtotal - discount - pointsDiscount;
    if (total < 0) total = 0;

    /* ── Pembayaran ── */
    let paidAmount = 0;
    let changeAmount = 0;
    let debtBalance = 0;
    let paymentStatus = 'PAID';

    if (type === 'CREDIT') {
      paidAmount = Math.min(toNumber(cash_amount), total);
      debtBalance = total - paidAmount;
      paymentStatus = debtBalance > 0 ? 'UNPAID' : 'PAID';
      if (debtBalance > 0 && !customer) {
        throw new Error('Transaksi tempo memerlukan data pelanggan.');
      }
      if (debtBalance > 0 && !due_date) {
        throw new Error('Transaksi tempo wajib memiliki tanggal jatuh tempo.');
      }
    } else {
      paidAmount = toNumber(cash_amount);
      if (type === 'CASH') {
        if (paidAmount < total) throw new Error('Uang diterima kurang dari total tagihan.');
        changeAmount = paidAmount - total;
      } else {
        // QRIS: nominal dianggap pas.
        paidAmount = total;
      }
    }

    const paidBy = actor;
    const insertSale = db.prepare(`
      INSERT INTO pos_sales (
        invoice_no, customer_id, subtotal, discount_amount, points_discount, points_earned, points_redeemed,
        total_amount, total_profit, payment_type, payment_status, paid_amount, change_amount, debt_balance,
        due_date, cashier_id, cashier_name, note
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const saleInfo = insertSale.run(
      invoiceNo, customer_id || null, subtotal, discount, pointsDiscount, pointsRedeemed,
      total, totalProfit, type, paymentStatus, paidAmount, changeAmount, debtBalance,
      due_date || null, currentCashierId(session), paidBy, String(note || '').trim()
    );
    const saleId = Number(saleInfo.lastInsertRowid);

    const insertItem = db.prepare(`
      INSERT INTO pos_sale_items (sale_id, product_id, unit_id, unit_name, conversion_factor, qty, price_used, cost_price, subtotal, profit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStock = db.prepare('UPDATE pos_products SET stock = stock - ?, updated_at = (NOW_LOCAL()) WHERE id = ?');

    for (const line of lines) {
      insertItem.run(
        saleId, line.product.id, line.unit.id, line.unit.unit_name, line.factor,
        line.qty, line.priceUsed, toNumber(line.product.cost_price), line.lineSubtotal, line.lineProfit
      );
      updateStock.run(line.qtyBase, line.product.id);

      const after = db.prepare('SELECT stock FROM pos_products WHERE id = ?').get(line.product.id);
      logStock({
        productId: line.product.id,
        qtyChange: -line.qtyBase,
        stockAfter: after?.stock ?? null,
        type: 'SALE',
        reference: invoiceNo,
        actor: paidBy
      });
    }

    /* ── Poin: potong yang ditukar, tambah yang didapat ── */
    let pointsEarned = 0;
    if (customer && settings.loyalty_enabled) {
      const spendPerPoint = Math.max(1, toNumber(settings.loyalty_spend_per_point, true));
      pointsEarned = Math.floor(total / spendPerPoint);

      if (pointsRedeemed > 0) {
        db.prepare('UPDATE pos_customers SET points = points - ? WHERE id = ?').run(pointsRedeemed, customer.id);
        db.prepare(`
          INSERT INTO pos_point_logs (customer_id, sale_id, points_change, type, description)
          VALUES (?, ?, ?, 'REDEEM', ?)
        `).run(customer.id, saleId, -pointsRedeemed, `Tukar ${pointsRedeemed} poin di nota ${invoiceNo}`);
      }
      if (pointsEarned > 0) {
        db.prepare('UPDATE pos_customers SET points = points + ? WHERE id = ?').run(pointsEarned, customer.id);
        db.prepare(`
          INSERT INTO pos_point_logs (customer_id, sale_id, points_change, type, description)
          VALUES (?, ?, ?, 'EARN', ?)
        `).run(customer.id, saleId, pointsEarned, `Poin dari belanja Rp ${formatMoney(total)} di nota ${invoiceNo}`);
      }
      db.prepare('UPDATE pos_sales SET points_earned = ? WHERE id = ?').run(pointsEarned, saleId);
    }

    return {
      saleId,
      invoiceNo,
      subtotal,
      discount,
      pointsDiscount,
      total,
      paidAmount,
      changeAmount,
      debtBalance,
      paymentStatus,
      pointsEarned,
      pointsRedeemed,
      items: lines.map((l) => ({
        name: l.product.name,
        unit_name: l.unit.unit_name,
        qty: l.qty,
        price_used: l.priceUsed,
        subtotal: l.lineSubtotal
      }))
    };
  })();
}

/** Batalkan transaksi: kembalikan stok dan nolkan piutang. */
function voidSale(saleId, session) {
  const actor = actorName(session, 'Admin');
  return db.transaction(() => {
    const sale = db.prepare('SELECT * FROM pos_sales WHERE id = ?').get(saleId);
    if (!sale) throw new Error('Transaksi tidak ditemukan.');
    if (sale.payment_status === 'VOID') throw new Error('Transaksi ini sudah dibatalkan.');

    const items = db.prepare('SELECT * FROM pos_sale_items WHERE sale_id = ?').all(saleId);
    const restore = db.prepare('UPDATE pos_products SET stock = stock + ?, updated_at = (NOW_LOCAL()) WHERE id = ?');

    for (const item of items) {
      const back = toNumber(item.qty) * Math.max(1, toNumber(item.conversion_factor, true));
      restore.run(back, item.product_id);
      const after = db.prepare('SELECT stock FROM pos_products WHERE id = ?').get(item.product_id);
      logStock({
        productId: item.product_id,
        qtyChange: back,
        stockAfter: after?.stock ?? null,
        type: 'VOID',
        reference: sale.invoice_no,
        actor
      });
    }

    db.prepare(`
      UPDATE pos_sales SET payment_status = 'VOID', debt_balance = 0, total_profit = 0 WHERE id = ?
    `).run(saleId);

    // Poin yang sempat didapat ditarik kembali, poin yang ditukar dikembalikan.
    if (sale.customer_id) {
      if (toNumber(sale.points_earned, true) > 0) {
        db.prepare('UPDATE pos_customers SET points = MAX(0, points - ?) WHERE id = ?')
          .run(toNumber(sale.points_earned, true), sale.customer_id);
      }
      if (toNumber(sale.points_redeemed, true) > 0) {
        db.prepare('UPDATE pos_customers SET points = points + ? WHERE id = ?')
          .run(toNumber(sale.points_redeemed, true), sale.customer_id);
      }
      db.prepare(`
        INSERT INTO pos_point_logs (customer_id, sale_id, points_change, type, description)
        VALUES (?, ?, 0, 'ADJUSTMENT', ?)
      `).run(sale.customer_id, saleId, `Penyesuaian poin karena void nota ${sale.invoice_no}`);
    }

    return { invoiceNo: sale.invoice_no };
  })();
}

/** Item yang masih bisa diretur (qty beli dikurangi retur sebelumnya). */
function listRefundableItems(saleId) {
  return db.prepare(`
    SELECT i.*, p.name AS product_name
    FROM pos_sale_items i
    JOIN pos_products p ON i.product_id = p.id
    WHERE i.sale_id = ? AND (i.qty - COALESCE(i.refunded_qty, 0)) > 0
  `).all(saleId);
}

function refundSaleItem({ saleId, saleItemId, qty, reason = '' }, session) {
  const actor = actorName(session, 'Admin');
  const amountQty = toNumber(qty);
  if (amountQty <= 0) throw new Error('Jumlah retur harus lebih dari 0.');

  return db.transaction(() => {
    const sale = db.prepare('SELECT * FROM pos_sales WHERE id = ?').get(saleId);
    if (!sale) throw new Error('Transaksi tidak ditemukan.');
    if (sale.payment_status === 'VOID') throw new Error('Nota sudah dibatalkan, tidak bisa diretur.');

    const item = db.prepare('SELECT * FROM pos_sale_items WHERE id = ? AND sale_id = ?').get(saleItemId, saleId);
    if (!item) throw new Error('Item tidak ditemukan pada nota ini.');

    const remaining = toNumber(item.qty) - toNumber(item.refunded_qty, true);
    if (amountQty > remaining) throw new Error(`Jumlah retur melebihi sisa yang bisa diretur (${remaining}).`);

    const factor = Math.max(1, toNumber(item.conversion_factor, true));
    const qtyBase = amountQty * factor;
    const amount = amountQty * toNumber(item.price_used);
    const profitBack = amount - (qtyBase * toNumber(item.cost_price));

    db.prepare('UPDATE pos_products SET stock = stock + ?, updated_at = (NOW_LOCAL()) WHERE id = ?')
      .run(qtyBase, item.product_id);
    const after = db.prepare('SELECT stock FROM pos_products WHERE id = ?').get(item.product_id);

    logStock({
      productId: item.product_id,
      qtyChange: qtyBase,
      stockAfter: after?.stock ?? null,
      type: 'REFUND',
      reference: `${sale.invoice_no} (retur)`,
      actor,
      note: reason
    });

    db.prepare('UPDATE pos_sale_items SET refunded_qty = COALESCE(refunded_qty, 0) + ? WHERE id = ?')
      .run(amountQty, saleItemId);

    db.prepare(`
      INSERT INTO pos_sale_refunds (sale_id, sale_item_id, qty, amount, reason, actor)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(saleId, saleItemId, amountQty, amount, String(reason || '').trim(), actor);

    // Sesuaikan total nota dan profit agar laporan tetap akurat.
    const newTotal = Math.max(0, toNumber(sale.total_amount) - amount);
    const newProfit = toNumber(sale.total_profit) - profitBack;
    const newBalance = Math.max(0, toNumber(sale.debt_balance) - amount);
    db.prepare(`
      UPDATE pos_sales SET total_amount = ?, total_profit = ?, debt_balance = ?, payment_status = ?
      WHERE id = ?
    `).run(newTotal, newProfit, newBalance, newBalance > 0 ? 'UNPAID' : (sale.payment_status === 'VOID' ? 'VOID' : 'PAID'), saleId);

    return { amount, qty: amountQty, invoiceNo: sale.invoice_no };
  })();
}

/* ───────────────────────────── Riwayat & detail ───────────────────────────── */

function listSales({ startDate = null, endDate = null, paymentType = null, status = null, search = '', limit = 200 } = {}) {
  let sql = `
    SELECT s.*, c.name AS customer_name
    FROM pos_sales s
    LEFT JOIN pos_customers c ON s.customer_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (startDate) { sql += " AND date(s.sale_date, 'localtime') >= date(?)"; params.push(startDate); }
  if (endDate) { sql += " AND date(s.sale_date, 'localtime') <= date(?)"; params.push(endDate); }
  if (paymentType) { sql += ' AND s.payment_type = ?'; params.push(paymentType); }
  if (status) { sql += ' AND s.payment_status = ?'; params.push(status); }
  if (search) {
    sql += ' AND (s.invoice_no LIKE ? OR c.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY s.sale_date DESC, s.id DESC LIMIT ?';
  params.push(toNumber(limit, true) || 200);

  return db.prepare(sql).all(...params);
}

function getSaleDetail(saleId) {
  const sale = db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone
    FROM pos_sales s
    LEFT JOIN pos_customers c ON s.customer_id = c.id
    WHERE s.id = ?
  `).get(saleId);
  if (!sale) return null;

  sale.items = db.prepare(`
    SELECT i.*, p.name AS product_name, p.sku AS product_sku
    FROM pos_sale_items i
    JOIN pos_products p ON i.product_id = p.id
    WHERE i.sale_id = ?
  `).all(saleId);

  sale.refunds = db.prepare(`
    SELECT r.*, p.name AS product_name
    FROM pos_sale_refunds r
    JOIN pos_sale_items i ON r.sale_item_id = i.id
    JOIN pos_products p ON i.product_id = p.id
    WHERE r.sale_id = ?
    ORDER BY r.created_at DESC
  `).all(saleId);

  sale.payments = db.prepare('SELECT * FROM pos_debt_payments WHERE sale_id = ? ORDER BY payment_date DESC').all(saleId);
  return sale;
}

/* ───────────────────────────── Piutang & hutang ───────────────────────────── */

function listCustomerDebts() {
  return db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone,
           CAST(julianday('now', 'localtime') - julianday(s.due_date) AS INTEGER) AS days_overdue
    FROM pos_sales s
    JOIN pos_customers c ON s.customer_id = c.id
    WHERE s.debt_balance > 0 AND s.payment_status != 'VOID'
    ORDER BY s.due_date ASC
  `).all();
}

function payCustomerDebt({ saleId, amount, note = '' }, session) {
  const actor = actorName(session, 'Admin');
  const value = toNumber(amount);
  if (value <= 0) throw new Error('Nominal pembayaran harus lebih dari 0.');

  return db.transaction(() => {
    const sale = db.prepare('SELECT * FROM pos_sales WHERE id = ?').get(saleId);
    if (!sale) throw new Error('Nota tidak ditemukan.');
    if (toNumber(sale.debt_balance) <= 0) throw new Error('Nota ini tidak memiliki sisa piutang.');
    if (value > toNumber(sale.debt_balance)) {
      throw new Error(`Pembayaran melebihi sisa piutang (Rp ${formatMoney(sale.debt_balance)}).`);
    }

    db.prepare(`
      INSERT INTO pos_debt_payments (sale_id, amount, actor, note)
      VALUES (?, ?, ?, ?)
    `).run(saleId, value, actor, String(note || '').trim());

    const newBalance = toNumber(sale.debt_balance) - value;
    db.prepare(`
      UPDATE pos_sales SET debt_balance = ?, payment_status = ? WHERE id = ?
    `).run(newBalance, newBalance <= 0 ? 'PAID' : 'UNPAID', saleId);

    return { invoiceNo: sale.invoice_no, paid: value, balance: newBalance };
  })();
}

function listSupplierDebts() {
  return db.prepare(`
    SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone
    FROM pos_purchases p
    JOIN pos_suppliers s ON p.supplier_id = s.id
    WHERE p.debt_balance > 0
    ORDER BY p.due_date ASC
  `).all();
}

function paySupplierDebt({ purchaseId, amount, note = '' }, session) {
  const actor = actorName(session, 'Admin');
  const value = toNumber(amount);
  if (value <= 0) throw new Error('Nominal pembayaran harus lebih dari 0.');

  return db.transaction(() => {
    const purchase = db.prepare('SELECT * FROM pos_purchases WHERE id = ?').get(purchaseId);
    if (!purchase) throw new Error('Pembelian tidak ditemukan.');
    if (value > toNumber(purchase.debt_balance)) {
      throw new Error(`Pembayaran melebihi sisa hutang (Rp ${formatMoney(purchase.debt_balance)}).`);
    }

    db.prepare(`
      INSERT INTO pos_supplier_debt_payments (purchase_id, amount, actor, note)
      VALUES (?, ?, ?, ?)
    `).run(purchaseId, value, actor, String(note || '').trim());

    const newBalance = toNumber(purchase.debt_balance) - value;
    db.prepare('UPDATE pos_purchases SET debt_balance = ?, payment_status = ? WHERE id = ?')
      .run(newBalance, newBalance <= 0 ? 'PAID' : 'UNPAID', purchaseId);

    return { purchaseNo: purchase.purchase_no, paid: value, balance: newBalance };
  })();
}

/* ───────────────────────────── Pembelian supplier ───────────────────────────── */

function createPurchase(payload, session) {
  const {
    supplier_id = null,
    payment_type = 'CASH',
    cash_paid = 0,
    due_date = null,
    note = '',
    items = []
  } = payload || {};

  if (!Array.isArray(items) || items.length === 0) throw new Error('Daftar pembelian masih kosong.');
  const type = String(payment_type).toUpperCase() === 'CREDIT' ? 'CREDIT' : 'CASH';
  const actor = actorName(session, 'Admin');

  return db.transaction(() => {
    const purchaseNo = generateDocNumber('PO', 'pos_purchases', 'purchase_date');

    let total = 0;
    const lines = [];
    for (const raw of items) {
      const product = db.prepare('SELECT * FROM pos_products WHERE id = ?').get(raw.product_id);
      if (!product) throw new Error(`Produk tidak ditemukan (id ${raw.product_id}).`);

      const qty = toNumber(raw.qty);
      const cost = toNumber(raw.cost_price);
      if (qty <= 0) throw new Error(`Jumlah tidak valid untuk ${product.name}.`);
      if (cost < 0) throw new Error(`Harga modal tidak valid untuk ${product.name}.`);

      const factor = Math.max(1, toNumber(raw.conversion_factor, true));
      const qtyBase = qty * factor;
      const subtotal = qty * cost;
      total += subtotal;
      lines.push({ product, qty, factor, qtyBase, cost, subtotal, expiry_date: raw.expiry_date || null, unit_name: raw.unit_name || product.unit });
    }

    let paid = toNumber(cash_paid);
    let debtBalance = 0;
    let status = 'PAID';

    if (type === 'CREDIT') {
      if (paid > total) paid = total;
      debtBalance = total - paid;
      status = debtBalance > 0 ? 'UNPAID' : 'PAID';
      if (debtBalance > 0 && !due_date) throw new Error('Pembelian tempo wajib memiliki tanggal jatuh tempo.');
    } else {
      paid = total;
    }

    if (debtBalance > 0 && !supplier_id) throw new Error('Pembelian tempo memerlukan data supplier.');

    const info = db.prepare(`
      INSERT INTO pos_purchases (purchase_no, supplier_id, total_amount, paid_amount, debt_balance, payment_type, payment_status, due_date, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(purchaseNo, supplier_id || null, total, paid, debtBalance, type, status, due_date || null, String(note || '').trim());
    const purchaseId = Number(info.lastInsertRowid);

    const insertItem = db.prepare(`
      INSERT INTO pos_purchase_items (purchase_id, product_id, unit_name, conversion_factor, qty, cost_price, subtotal, expiry_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStock = db.prepare('UPDATE pos_products SET stock = stock + ?, updated_at = (NOW_LOCAL()) WHERE id = ?');

    for (const line of lines) {
      insertItem.run(purchaseId, line.product.id, line.unit_name, line.factor, line.qty, line.cost, line.subtotal, line.expiry_date);
      updateStock.run(line.qtyBase, line.product.id);

      const after = db.prepare('SELECT stock FROM pos_products WHERE id = ?').get(line.product.id);
      logStock({
        productId: line.product.id,
        qtyChange: line.qtyBase,
        stockAfter: after?.stock ?? null,
        type: 'PURCHASE',
        reference: purchaseNo,
        actor
      });

      // Perbarui harga modal produk bila berubah.
      if (line.cost > 0) {
        db.prepare('UPDATE pos_products SET cost_price = ? WHERE id = ?').run(line.cost, line.product.id);
      }
      if (line.expiry_date) {
        db.prepare('UPDATE pos_products SET expiry_date = ? WHERE id = ?').run(line.expiry_date, line.product.id);
      }
    }

    if (type === 'CREDIT' && paid > 0) {
      db.prepare(`
        INSERT INTO pos_supplier_debt_payments (purchase_id, amount, actor, note)
        VALUES (?, ?, ?, 'Uang muka pembelian')
      `).run(purchaseId, paid, actor);
    }

    return { purchaseId, purchaseNo, total, paid, debtBalance, status };
  })();
}

function listPurchases({ search = '', limit = 200 } = {}) {
  let sql = `
    SELECT p.*, s.name AS supplier_name
    FROM pos_purchases p
    LEFT JOIN pos_suppliers s ON p.supplier_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (search) {
    sql += ' AND (p.purchase_no LIKE ? OR s.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY p.purchase_date DESC, p.id DESC LIMIT ?';
  params.push(toNumber(limit, true) || 200);
  return db.prepare(sql).all(...params);
}

function getPurchaseDetail(purchaseId) {
  const purchase = db.prepare(`
    SELECT p.*, s.name AS supplier_name
    FROM pos_purchases p
    LEFT JOIN pos_suppliers s ON p.supplier_id = s.id
    WHERE p.id = ?
  `).get(purchaseId);
  if (!purchase) return null;
  purchase.items = db.prepare(`
    SELECT i.*, pr.name AS product_name
    FROM pos_purchase_items i
    JOIN pos_products pr ON i.product_id = pr.id
    WHERE i.purchase_id = ?
  `).all(purchaseId);
  purchase.payments = db.prepare('SELECT * FROM pos_supplier_debt_payments WHERE purchase_id = ? ORDER BY payment_date DESC').all(purchaseId);
  return purchase;
}

/* ───────────────────────────── Supplier & pelanggan toko ───────────────────────────── */

function listSuppliers() {
  return db.prepare('SELECT * FROM pos_suppliers ORDER BY name ASC').all();
}

function createSupplier({ name, phone = '', address = '', note = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama supplier wajib diisi.');
  return db.prepare('INSERT INTO pos_suppliers (name, phone, address, note) VALUES (?, ?, ?, ?)')
    .run(clean, String(phone || '').trim(), String(address || '').trim(), String(note || '').trim());
}

function updateSupplier(id, { name, phone = '', address = '', note = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama supplier wajib diisi.');
  return db.prepare('UPDATE pos_suppliers SET name = ?, phone = ?, address = ?, note = ? WHERE id = ?')
    .run(clean, String(phone || '').trim(), String(address || '').trim(), String(note || '').trim(), id);
}

function deleteSupplier(id) {
  return db.prepare('DELETE FROM pos_suppliers WHERE id = ?').run(id);
}

function listStoreCustomers(search = '') {
  let sql = 'SELECT * FROM pos_customers WHERE 1=1';
  const params = [];
  if (search) {
    sql += ' AND (name LIKE ? OR phone LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY name ASC';
  return db.prepare(sql).all(...params);
}

function createStoreCustomer({ name, phone = '', address = '', note = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama pelanggan wajib diisi.');
  return db.prepare('INSERT INTO pos_customers (name, phone, address, note) VALUES (?, ?, ?, ?)')
    .run(clean, String(phone || '').trim(), String(address || '').trim(), String(note || '').trim());
}

function updateStoreCustomer(id, { name, phone = '', address = '', note = '' }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama pelanggan wajib diisi.');
  return db.prepare('UPDATE pos_customers SET name = ?, phone = ?, address = ?, note = ? WHERE id = ?')
    .run(clean, String(phone || '').trim(), String(address || '').trim(), String(note || '').trim(), id);
}

function deleteStoreCustomer(id) {
  return db.prepare('DELETE FROM pos_customers WHERE id = ?').run(id);
}

function listPointLogs(customerId, limit = 100) {
  return db.prepare(`
    SELECT l.*, s.invoice_no
    FROM pos_point_logs l
    LEFT JOIN pos_sales s ON l.sale_id = s.id
    WHERE l.customer_id = ?
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ?
  `).all(customerId, toNumber(limit, true) || 100);
}

function adjustCustomerPoints({ customerId, pointsChange, reason = '' }, session) {
  const delta = toNumber(pointsChange, true);
  if (!customerId || delta === 0) throw new Error('Perubahan poin tidak valid.');
  const actor = actorName(session, 'Admin');

  return db.transaction(() => {
    const customer = db.prepare('SELECT id, name, points FROM pos_customers WHERE id = ?').get(customerId);
    if (!customer) throw new Error('Pelanggan toko tidak ditemukan.');

    const next = Math.max(0, toNumber(customer.points, true) + delta);
    db.prepare('UPDATE pos_customers SET points = ? WHERE id = ?').run(next, customerId);
    db.prepare(`
      INSERT INTO pos_point_logs (customer_id, points_change, type, description)
      VALUES (?, ?, 'ADJUSTMENT', ?)
    `).run(customerId, delta, String(reason || `Penyesuaian oleh ${actor}`).trim());

    return next;
  })();
}

/* ───────────────────────────── Buku kas ───────────────────────────── */

function listExpenses({ startDate = null, endDate = null, category = null, limit = 200 } = {}) {
  let sql = 'SELECT * FROM pos_expenses WHERE 1=1';
  const params = [];
  if (startDate) { sql += " AND date(expense_date, 'localtime') >= date(?)"; params.push(startDate); }
  if (endDate) { sql += " AND date(expense_date, 'localtime') <= date(?)"; params.push(endDate); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY expense_date DESC, id DESC LIMIT ?';
  params.push(toNumber(limit, true) || 200);
  return db.prepare(sql).all(...params);
}

function createExpense({ category, amount, description = '', expense_date = null }, session) {
  const cleanCat = String(category || '').trim();
  const value = toNumber(amount);
  if (!cleanCat) throw new Error('Kategori pengeluaran wajib diisi.');
  if (value <= 0) throw new Error('Nominal pengeluaran harus lebih dari 0.');

  const actor = actorName(session, 'Admin');
  const info = db.prepare(`
    INSERT INTO pos_expenses (expense_date, category, amount, description, actor)
    VALUES (COALESCE(?, (NOW_LOCAL())), ?, ?, ?, ?)
  `).run(expense_date || null, cleanCat, value, String(description || '').trim(), actor);

  return Number(info.lastInsertRowid);
}

function deleteExpense(id) {
  return db.prepare('DELETE FROM pos_expenses WHERE id = ?').run(id);
}

/* ───────────────────────────── Shift kasir ───────────────────────────── */

function getActiveShift(session) {
  const cashierId = currentCashierId(session);
  if (cashierId === null) return null;
  return db.prepare(`
    SELECT * FROM pos_shifts WHERE cashier_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1
  `).get(cashierId) || null;
}

/** Ringkasan shift berjalan: penjualan per metode, kas seharusnya. */
function getShiftSummary(shift) {
  if (!shift) return null;

  const cash = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS count
    FROM pos_sales WHERE sale_date >= ? AND cashier_id = ? AND payment_type = 'CASH' AND payment_status != 'VOID'
  `).get(shift.opened_at, shift.cashier_id);

  const qris = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS count
    FROM pos_sales WHERE sale_date >= ? AND cashier_id = ? AND payment_type = 'QRIS' AND payment_status != 'VOID'
  `).get(shift.opened_at, shift.cashier_id);

  const credit = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS count
    FROM pos_sales WHERE sale_date >= ? AND cashier_id = ? AND payment_type = 'CREDIT' AND payment_status != 'VOID'
  `).get(shift.opened_at, shift.cashier_id);

  const debtCollected = db.prepare(`
    SELECT COALESCE(SUM(p.amount),0) AS total
    FROM pos_debt_payments p
    JOIN pos_sales s ON p.sale_id = s.id
    WHERE p.payment_date >= ? AND s.cashier_id = ?
  `).get(shift.opened_at, shift.cashier_id);

  const expensesPaid = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM pos_expenses WHERE expense_date >= ?
  `).get(shift.opened_at);

  const expectedCash = toNumber(shift.starting_cash) + cash.total + debtCollected.total - expensesPaid.total;

  return {
    ...shift,
    cash_sales: cash.total, cash_count: cash.count,
    qris_sales: qris.total, qris_count: qris.count,
    credit_sales: credit.total, credit_count: credit.count,
    total_sales: cash.total + qris.total + credit.total,
    total_transactions: cash.count + qris.count + credit.count,
    debt_collected: debtCollected.total,
    expenses_paid: expensesPaid.total,
    expected_cash: expectedCash
  };
}

function openShift({ starting_cash = 0, note = '' }, session) {
  const existing = getActiveShift(session);
  if (existing) throw new Error('Masih ada shift yang belum ditutup.');

  const cashierId = currentCashierId(session);
  if (cashierId === null) throw new Error('Shift kasir memerlukan akun kasir yang valid.');

  const info = db.prepare(`
    INSERT INTO pos_shifts (cashier_id, cashier_name, starting_cash, note)
    VALUES (?, ?, ?, ?)
  `).run(cashierId, actorName(session, 'Kasir'), toNumber(starting_cash), String(note || '').trim());

  return Number(info.lastInsertRowid);
}

function closeShift({ actual_cash, note = '' }, session) {
  const value = toNumber(actual_cash);
  return db.transaction(() => {
    const shift = getActiveShift(session);
    if (!shift) throw new Error('Tidak ada shift aktif untuk ditutup.');
    if (!Number.isFinite(Number(actual_cash))) throw new Error('Uang fisik di laci wajib diisi.');

    const summary = getShiftSummary(shift);
    const difference = value - toNumber(summary.expected_cash);

    db.prepare(`
      UPDATE pos_shifts
      SET status = 'CLOSED', closed_at = (NOW_LOCAL()),
          cash_sales = ?, qris_sales = ?, credit_sales = ?,
          debt_collected = ?, expenses_paid = ?, expected_cash = ?,
          actual_cash = ?, difference = ?, note = ?
      WHERE id = ?
    `).run(
      summary.cash_sales, summary.qris_sales, summary.credit_sales,
      summary.debt_collected, summary.expenses_paid, summary.expected_cash,
      value, difference, String(note || shift.note || '').trim(), shift.id
    );

    return { ...summary, actual_cash: value, difference, status: 'CLOSED' };
  })();
}

function listShifts(session, limit = 50) {
  const cashierId = currentCashierId(session);
  if (cashierId === null) return [];
  return db.prepare('SELECT * FROM pos_shifts WHERE cashier_id = ? ORDER BY id DESC LIMIT ?')
    .all(cashierId, toNumber(limit, true) || 50);
}

/* ───────────────────────────── Keranjang tertahan ───────────────────────────── */

function holdCart({ label = '', payload }, session) {
  const cashierId = currentCashierId(session);
  const info = db.prepare('INSERT INTO pos_held_carts (label, payload, cashier_id) VALUES (?, ?, ?)')
    .run(String(label || '').trim(), JSON.stringify(payload || {}), cashierId);
  return Number(info.lastInsertRowid);
}

function listHeldCarts(session) {
  const cashierId = currentCashierId(session);
  return db.prepare(`
    SELECT * FROM pos_held_carts
    WHERE cashier_id IS ? OR cashier_id IS NULL
    ORDER BY created_at DESC
  `).all(cashierId);
}

function deleteHeldCart(id) {
  return db.prepare('DELETE FROM pos_held_carts WHERE id = ?').run(id);
}

/* ───────────────────────────── Laporan ───────────────────────────── */

function getDashboardStats() {
  const today = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) AS total_sales,
           COALESCE(SUM(total_profit),0) AS total_profit,
           COUNT(*) AS total_tx
    FROM pos_sales
    WHERE date(sale_date, 'localtime') = date('now', 'localtime') AND payment_status != 'VOID'
  `).get();

  const month = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) AS total_sales,
           COALESCE(SUM(total_profit),0) AS total_profit,
           COUNT(*) AS total_tx
    FROM pos_sales
    WHERE strftime('%Y-%m', sale_date, 'localtime') = strftime('%Y-%m', 'now', 'localtime')
      AND payment_status != 'VOID'
  `).get();

  const expensesToday = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM pos_expenses
    WHERE date(expense_date, 'localtime') = date('now', 'localtime')
  `).get().total;

  const expensesMonth = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM pos_expenses
    WHERE strftime('%Y-%m', expense_date, 'localtime') = strftime('%Y-%m', 'now', 'localtime')
  `).get().total;

  const receivable = db.prepare('SELECT COALESCE(SUM(debt_balance),0) AS total FROM pos_sales WHERE debt_balance > 0 AND payment_status != \'VOID\'').get().total;
  const payable = db.prepare('SELECT COALESCE(SUM(debt_balance),0) AS total FROM pos_purchases WHERE debt_balance > 0').get().total;

  const productCount = db.prepare('SELECT COUNT(*) AS c FROM pos_products WHERE is_active = 1').get().c;
  const lowStock = db.prepare('SELECT COUNT(*) AS c FROM pos_products WHERE is_active = 1 AND min_stock > 0 AND stock <= min_stock').get().c;

  return {
    today: { ...today, expenses: expensesToday, net_profit: toNumber(today.total_profit) - toNumber(expensesToday) },
    month: { ...month, expenses: expensesMonth, net_profit: toNumber(month.total_profit) - toNumber(expensesMonth) },
    receivable,
    payable,
    productCount,
    lowStock,
    lowStockItems: pos.listLowStock().slice(0, 10),
    recentSales: listSales({ limit: 10 }),
    stockLogs: pos.listStockLogs(15)
  };
}

function getSalesReport({ startDate = null, endDate = null } = {}) {
  const where = ["payment_status != 'VOID'"];
  const params = [];
  if (startDate) { where.push("date(sale_date, 'localtime') >= date(?)"); params.push(startDate); }
  if (endDate) { where.push("date(sale_date, 'localtime') <= date(?)"); params.push(endDate); }
  const clause = where.join(' AND ');

  const summary = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) AS total_sales,
           COALESCE(SUM(total_profit),0) AS total_profit,
           COALESCE(SUM(discount_amount),0) AS total_discount,
           COUNT(*) AS total_tx
    FROM pos_sales WHERE ${clause}
  `).get(...params);

  const byPayment = db.prepare(`
    SELECT payment_type, COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS count
    FROM pos_sales WHERE ${clause}
    GROUP BY payment_type
  `).all(...params);

  const daily = db.prepare(`
    SELECT date(sale_date, 'localtime') AS day,
           COALESCE(SUM(total_amount),0) AS total,
           COALESCE(SUM(total_profit),0) AS profit,
           COUNT(*) AS count
    FROM pos_sales WHERE ${clause}
    GROUP BY day ORDER BY day DESC LIMIT 60
  `).all(...params);

  return { summary, byPayment, daily };
}

/** Produk terlaris berdasarkan qty dan omzet. */
function getTopSelling({ startDate = null, endDate = null, limit = 20 } = {}) {
  const where = ["s.payment_status != 'VOID'"];
  const params = [];
  if (startDate) { where.push("date(s.sale_date, 'localtime') >= date(?)"); params.push(startDate); }
  if (endDate) { where.push("date(s.sale_date, 'localtime') <= date(?)"); params.push(endDate); }
  params.push(toNumber(limit, true) || 20);

  return db.prepare(`
    SELECT p.id, p.name, p.sku, c.name AS category_name,
           SUM(i.qty * i.conversion_factor) AS qty_sold,
           SUM(i.subtotal) AS revenue,
           SUM(i.profit) AS profit
    FROM pos_sale_items i
    JOIN pos_sales s ON i.sale_id = s.id
    JOIN pos_products p ON i.product_id = p.id
    LEFT JOIN pos_categories c ON p.category_id = c.id
    WHERE ${where.join(' AND ')}
    GROUP BY p.id
    ORDER BY qty_sold DESC, revenue DESC
    LIMIT ?
  `).all(...params);
}

module.exports = {
  actorName,
  formatMoney,
  generateDocNumber,

  checkout,
  voidSale,
  listRefundableItems,
  refundSaleItem,
  listSales,
  getSaleDetail,

  listCustomerDebts,
  payCustomerDebt,
  listSupplierDebts,
  paySupplierDebt,

  createPurchase,
  listPurchases,
  getPurchaseDetail,

  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  listStoreCustomers,
  createStoreCustomer,
  updateStoreCustomer,
  deleteStoreCustomer,
  listPointLogs,
  adjustCustomerPoints,

  listExpenses,
  createExpense,
  deleteExpense,

  getActiveShift,
  getShiftSummary,
  openShift,
  closeShift,
  listShifts,

  holdCart,
  listHeldCarts,
  deleteHeldCart,

  getDashboardStats,
  getSalesReport,
  getTopSelling
};
