/** Modul ini adalah PRESENTATION/AGGREGATION LAYER murni di atas tabel kredensial */

const db = require('../config/database');
const adminSvc = require('./adminService');
const agentSvc = require('./agentService');
const permSvc = require('./userPermissionService');
const sidebarMenuSvc = require('./sidebarMenuService');

const MANAGED_SOURCES = Object.freeze(['technicians', 'cashiers', 'collectors', 'agents']);

const SOURCE_TO_ROLE = Object.freeze({
  technicians: 'teknisi',
  cashiers: 'customer_service',
  collectors: 'kolektor',
  agents: 'reseller',
  customers: 'pelanggan',
  admin: 'admin'
});

/** Label role profesional untuk UI */
const ROLE_LABELS = Object.freeze({
  admin: 'Admin',
  customer_service: 'Kasir',
  kolektor: 'Kolektor',
  reseller: 'Reseller',
  teknisi: 'Teknisi',
  pelanggan: 'Pelanggan'
});

function safeStr(v) {
  return v === null || v === undefined ? '' : String(v);
}

/** Unified read model: { source, id, name, username, phone, role, active, extra } */
function listUnifiedUsers() {
  const rows = [];
  const permMap = permSvc.getAllPermissionsMap();
  const attach = (row) => {
    const custom = permMap[`${row.source}:${row.id}`];
    row.permissions = custom || null;
    row.customPermissions = Array.isArray(custom);
    row.roleLabel = ROLE_LABELS[row.role] || row.role;
    rows.push(row);
  };

  try {
    for (const t of adminSvc.getAllTechnicians()) {
      attach({ source: 'technicians', id: t.id, name: t.name, username: t.username, phone: t.phone || '', area: t.area || '', role: SOURCE_TO_ROLE.technicians, active: !!t.is_active });
    }
  } catch (e) {  }

  try {
    for (const c of adminSvc.getAllCashiers()) {
      attach({ source: 'cashiers', id: c.id, name: c.name, username: c.username, phone: c.phone || '', area: '', role: SOURCE_TO_ROLE.cashiers, active: !!c.is_active });
    }
  } catch (e) {}

  try {
    for (const c of adminSvc.getAllCollectors()) {
      attach({ source: 'collectors', id: c.id, name: c.name, username: c.username, phone: c.phone || '', area: c.area || '', role: SOURCE_TO_ROLE.collectors, active: !!c.is_active });
    }
  } catch (e) {}

  try {
    for (const a of agentSvc.getAllAgents()) {
      attach({ source: 'agents', id: a.id, name: a.name, username: a.username, phone: a.phone || '', area: '', role: SOURCE_TO_ROLE.agents, active: !!a.is_active });
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
  const name = safeStr(data.name).trim();
  if (!username) throw new Error('Username wajib diisi');
  if (!name) throw new Error('Nama wajib diisi');
  if (password.length < 4) throw new Error('Password minimal 4 karakter');

  const dup = db.prepare(`SELECT id FROM ${source} WHERE username = ?`).get(username);
  if (dup) throw new Error('Username sudah digunakan');

  let result;
  switch (source) {
    case 'technicians': result = adminSvc.createTechnician({ username, password, name, phone: data.phone, area: data.area }); break;
    case 'cashiers': result = adminSvc.createCashier({ username, password, name, phone: data.phone }); break;
    case 'collectors': result = adminSvc.createCollector({ username, password, name, phone: data.phone, area: data.area, auto_approve: data.auto_approve }); break;
    case 'agents': result = agentSvc.createAgent({ username, password, name, phone: data.phone, balance: 0, billing_fee: data.billing_fee }); break;
    default: throw new Error('Sumber tidak dikenal');
  }

  const newId = Number(result?.lastInsertRowid || 0);
  if (newId && data.permissions !== undefined) {
    savePermissions(source, newId, data.permissions);
  }
  return result;
}

function getUserRow(source, id) {
  getManagedTable(source);
  return db.prepare(`SELECT * FROM ${source} WHERE id = ?`).get(Number(id)) || null;
}

/**
 * Update data profil tanpa menyentuh password (kecuali data.password diisi).
 */
function updateUser(source, id, data) {
  getManagedTable(source);
  const existing = getUserRow(source, id);
  if (!existing) throw new Error('Pengguna tidak ditemukan');

  const username = safeStr(data.username ?? existing.username).trim();
  const name = safeStr(data.name ?? existing.name).trim();
  const phone = safeStr(data.phone ?? existing.phone).trim();
  if (!username) throw new Error('Username wajib diisi');
  if (!name) throw new Error('Nama wajib diisi');

  const dup = db.prepare(`SELECT id FROM ${source} WHERE username = ? AND id != ?`).get(username, Number(id));
  if (dup) throw new Error('Username sudah digunakan');

  switch (source) {
    case 'technicians':
      db.prepare('UPDATE technicians SET username = ?, name = ?, phone = ?, area = ? WHERE id = ?')
        .run(username, name, phone, safeStr(data.area ?? existing.area).trim(), Number(id));
      break;
    case 'cashiers':
      db.prepare('UPDATE cashiers SET username = ?, name = ?, phone = ? WHERE id = ?')
        .run(username, name, phone, Number(id));
      break;
    case 'collectors':
      db.prepare('UPDATE collectors SET username = ?, name = ?, phone = ?, area = ? WHERE id = ?')
        .run(username, name, phone, safeStr(data.area ?? existing.area).trim(), Number(id));
      break;
    case 'agents':
      db.prepare('UPDATE agents SET username = ?, name = ?, phone = ? WHERE id = ?')
        .run(username, name, phone, Number(id));
      break;
    default: throw new Error('Sumber tidak dikenal');
  }

  if (safeStr(data.password).trim()) {
    resetPassword(source, id, data.password);
  }
  return true;
}

function deleteUser(source, id) {
  getManagedTable(source);
  try { permSvc.clearUserPermissions(source, id); } catch (e) {}
  return db.prepare(`DELETE FROM ${source} WHERE id = ?`).run(Number(id));
}

/** Normalisasi input checkbox permissions dari form → hanya key yang valid untuk role tersebut. */
function normalizePermissionInput(source, input) {
  const role = SOURCE_TO_ROLE[source];
  const sections = sidebarMenuSvc.getAssignableMenusForRole(role);
  const valid = new Set(sections.flatMap((s) => s.items.map((i) => i.key)));
  const raw = Array.isArray(input) ? input : (input ? [input] : []);
  return raw.map(String).filter((k) => valid.has(k));
}

function savePermissions(source, id, input) {
  getManagedTable(source);
  return permSvc.saveUserPermissions(source, id, normalizePermissionInput(source, input));
}

function setUserActive(source, id, active) {
  getManagedTable(source);
  const table = source; 
  const isActive = active ? 1 : 0;
  return db.prepare(`UPDATE ${table} SET is_active = ? WHERE id = ?`).run(isActive, id);
}

/** Reset password: WAJIB melalui hashPassword (PBKDF2), tidak pernah plaintext. */
function resetPassword(source, id, newPassword) {
  getManagedTable(source);
  const pw = safeStr(newPassword);
  if (pw.length < 4) throw new Error('Password baru terlalu pendek');
  const table = source;
  const hashed = adminSvc.hashPassword(pw);
  return db.prepare(`UPDATE ${table} SET password = ? WHERE id = ?`).run(hashed, id);
}

/** Struktur menu per role untuk render checkbox: { role: [{key,labelDefault,items:[...]}] } */
function getPermissionCatalog() {
  const catalog = {};
  for (const source of MANAGED_SOURCES) {
    catalog[source] = sidebarMenuSvc.getAssignableMenusForRole(SOURCE_TO_ROLE[source]);
  }
  return catalog;
}

module.exports = {
  MANAGED_SOURCES,
  SOURCE_TO_ROLE,
  ROLE_LABELS,
  listUnifiedUsers,
  listCustomersReadOnly,
  getUserRow,
  createUser,
  updateUser,
  deleteUser,
  setUserActive,
  resetPassword,
  savePermissions,
  getPermissionCatalog
};
