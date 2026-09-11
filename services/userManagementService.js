/**
 * services/userManagementService.js — Phase 5: Centralized Admin User Management
 *
 * ARSITEKTUR: TIDAK ada generic `users` table (keputusan Phase 3, tetap berlaku).
 * Modul ini adalah PRESENTATION/AGGREGATION LAYER murni di atas tabel kredensial
 * yang sudah ada (technicians, cashiers, collectors, agents). Tidak ada data yang
 * disimpan ke tabel baru — setiap operasi delegasi ke service asli masing-masing
 * sumber (adminService / agentService), yang sudah menggunakan PBKDF2 hashing
 * (Phase 2) dan tervalidasi aman.
 *
 * Sumber yang DIKELOLA (create/edit/status/reset password) dari halaman ini:
 *   technicians  -> canonical role: teknisi
 *   cashiers     -> canonical role: customer_service
 *   collectors   -> canonical role: kolektor
 *   agents       -> canonical role: reseller
 *
 * Sumber yang HANYA VIEW (read-only) dari halaman ini, karena sudah punya
 * halaman CRUD khusus yang lebih lengkap (package, billing, OTP, dsb) dan
 * di luar scope Phase 5 (DO NOT TOUCH customer portal/business logic):
 *   customers    -> canonical role: pelanggan (read-only summary)
 *   admin        -> canonical role: admin (read-only; admin account management
 *                   tetap AS-IS, lihat middleware/authz.js & Step 7 Phase 5)
 */

const db = require('../config/database');
const adminSvc = require('./adminService');
const agentSvc = require('./agentService');

const MANAGED_SOURCES = Object.freeze(['technicians', 'cashiers', 'collectors', 'agents']);

const SOURCE_TO_ROLE = Object.freeze({
  technicians: 'teknisi',
  cashiers: 'customer_service',
  collectors: 'kolektor',
  agents: 'reseller',
  customers: 'pelanggan',
  admin: 'admin'
});

function safeStr(v) {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Unified read model: { source, id, name, username, phone, role, active, extra }
 * TIDAK PERNAH menyertakan password/hash.
 */
function listUnifiedUsers() {
  const rows = [];

  try {
    for (const t of adminSvc.getAllTechnicians()) {
      rows.push({ source: 'technicians', id: t.id, name: t.name, username: t.username, phone: t.phone || '', area: t.area || '', role: SOURCE_TO_ROLE.technicians, active: !!t.is_active });
    }
  } catch (e) { /* tabel selalu ada; abaikan jika gagal baca */ }

  try {
    for (const c of adminSvc.getAllCashiers()) {
      rows.push({ source: 'cashiers', id: c.id, name: c.name, username: c.username, phone: c.phone || '', area: '', role: SOURCE_TO_ROLE.cashiers, active: !!c.is_active });
    }
  } catch (e) {}

  try {
    for (const c of adminSvc.getAllCollectors()) {
      rows.push({ source: 'collectors', id: c.id, name: c.name, username: c.username, phone: c.phone || '', area: c.area || '', role: SOURCE_TO_ROLE.collectors, active: !!c.is_active });
    }
  } catch (e) {}

  try {
    for (const a of agentSvc.getAllAgents()) {
      rows.push({ source: 'agents', id: a.id, name: a.name, username: a.username, phone: a.phone || '', area: '', role: SOURCE_TO_ROLE.agents, active: !!a.is_active });
    }
  } catch (e) {}

  return rows;
}

/**
 * Read-only customer summary (tidak untuk create/edit dari halaman ini).
 */
function listCustomersReadOnly(limit = 20) {
  try {
    return db.prepare('SELECT id, name, phone, pppoe_username, status FROM customers ORDER BY created_at DESC LIMIT ?').all(limit)
      .map(c => ({ source: 'customers', id: c.id, name: c.name, username: c.pppoe_username || c.phone || '', phone: c.phone || '', role: SOURCE_TO_ROLE.customers, active: c.status === 'active' }));
  } catch (e) {
    return [];
  }
}

function getManagedTable(source) {
  if (!MANAGED_SOURCES.includes(source)) {
    throw new Error(`Sumber tidak dikelola dari User Management: ${source}`);
  }
  return source;
}

function createUser(source, data) {
  getManagedTable(source);
  const username = safeStr(data.username).trim();
  const password = safeStr(data.password);
  if (!username) throw new Error('Username wajib diisi');
  if (!password) throw new Error('Password wajib diisi');

  switch (source) {
    case 'technicians': return adminSvc.createTechnician({ username, password, name: data.name, phone: data.phone, area: data.area });
    case 'cashiers': return adminSvc.createCashier({ username, password, name: data.name, phone: data.phone });
    case 'collectors': return adminSvc.createCollector({ username, password, name: data.name, phone: data.phone, area: data.area, auto_approve: data.auto_approve });
    case 'agents': return agentSvc.createAgent({ username, password, name: data.name, phone: data.phone, balance: 0, billing_fee: data.billing_fee });
    default: throw new Error('Sumber tidak dikenal');
  }
}

function updateUser(source, id, data) {
  getManagedTable(source);
  switch (source) {
    case 'technicians': return adminSvc.updateTechnician(id, data);
    case 'cashiers': return adminSvc.updateCashier(id, data);
    case 'collectors': return adminSvc.updateCollector(id, data);
    case 'agents': return agentSvc.updateAgent(id, data);
    default: throw new Error('Sumber tidak dikenal');
  }
}

function setUserActive(source, id, active) {
  getManagedTable(source);
  const table = source; // technicians|cashiers|collectors|agents — nama identik dengan tabel SQL
  const isActive = active ? 1 : 0;
  return db.prepare(`UPDATE ${table} SET is_active = ? WHERE id = ?`).run(isActive, id);
}

/**
 * Reset password: WAJIB melalui hashPassword (PBKDF2), tidak pernah plaintext.
 * Tidak mengembalikan password ke caller (Step 3/10: no display after save).
 */
function resetPassword(source, id, newPassword) {
  getManagedTable(source);
  const pw = safeStr(newPassword);
  if (pw.length < 4) throw new Error('Password baru terlalu pendek');
  const table = source;
  const hashed = adminSvc.hashPassword(pw);
  return db.prepare(`UPDATE ${table} SET password = ? WHERE id = ?`).run(hashed, id);
}

module.exports = {
  MANAGED_SOURCES,
  SOURCE_TO_ROLE,
  listUnifiedUsers,
  listCustomersReadOnly,
  createUser,
  updateUser,
  setUserActive,
  resetPassword
};
