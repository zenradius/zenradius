/**
 * Per-user menu permissions (allow-list of sidebar menu keys).
 * - Jika belum ada baris untuk user → fallback ke izin default role (semua menu role).
 * - Jika ada baris → hanya menu di daftar yang diizinkan (dashboard/beranda selalu diizinkan).
 */
const db = require('../config/database');

const SOURCE_BY_ROLE = Object.freeze({
  cashier: 'cashiers',
  customer_service: 'cashiers',
  teknisi: 'technicians',
  kolektor: 'collectors',
  reseller: 'agents'
});

const SESSION_ID_FIELD = Object.freeze({
  cashiers: 'cashierId',
  technicians: 'techId',
  collectors: 'collectorId',
  agents: 'agentId'
});

/** Menu yang selalu diizinkan walau tidak dicentang (halaman utama tiap portal). */
const ALWAYS_ALLOWED = new Set(['dashboard', 'cashier_attendance', 'tech_dashboard', 'agent_home', 'collector_dashboard']);

function parseKeys(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (e) {
    return [];
  }
}

/** @returns {string[]|null} null = belum dikustomisasi (pakai default role) */
function getUserPermissions(source, userId) {
  try {
    const row = db.prepare('SELECT menu_keys FROM user_permissions WHERE source = ? AND user_id = ?').get(String(source), Number(userId));
    if (!row) return null;
    return parseKeys(row.menu_keys);
  } catch (e) {
    return null;
  }
}

function saveUserPermissions(source, userId, menuKeys) {
  const clean = Array.from(new Set((Array.isArray(menuKeys) ? menuKeys : []).map((k) => String(k).trim()).filter(Boolean)));
  db.prepare(`
    INSERT INTO user_permissions (source, user_id, menu_keys, updated_at)
    VALUES (?, ?, ?, NOW_LOCAL())
    ON CONFLICT(source, user_id) DO UPDATE SET menu_keys = excluded.menu_keys, updated_at = NOW_LOCAL()
  `).run(String(source), Number(userId), JSON.stringify(clean));
  return clean;
}

function clearUserPermissions(source, userId) {
  db.prepare('DELETE FROM user_permissions WHERE source = ? AND user_id = ?').run(String(source), Number(userId));
}

/** Map { "source:id": string[] } untuk semua user yang dikustomisasi */
function getAllPermissionsMap() {
  const map = {};
  try {
    for (const row of db.prepare('SELECT source, user_id, menu_keys FROM user_permissions').all()) {
      map[`${row.source}:${row.user_id}`] = parseKeys(row.menu_keys);
    }
  } catch (e) {}
  return map;
}

/** Identitas user dari session → { source, id } atau null (admin utama / tidak dikenal). */
function getSessionIdentity(session) {
  if (!session) return null;
  if (session.isCashier && session.cashierId) return { source: 'cashiers', id: Number(session.cashierId) };
  if (session.isTechnician && session.techId) return { source: 'technicians', id: Number(session.techId) };
  if (session.isCollector && session.collectorId) return { source: 'collectors', id: Number(session.collectorId) };
  if (session.isAgent && session.agentId) return { source: 'agents', id: Number(session.agentId) };
  return null;
}

/**
 * @returns {boolean|null} true/false jika ada override per-user, null jika tidak ada override
 */
function checkSessionMenuOverride(session, menuKey) {
  const ident = getSessionIdentity(session);
  if (!ident) return null;
  const allowed = getUserPermissions(ident.source, ident.id);
  if (allowed === null) return null;
  if (ALWAYS_ALLOWED.has(menuKey)) return true;
  return allowed.includes(menuKey);
}

module.exports = {
  SOURCE_BY_ROLE,
  SESSION_ID_FIELD,
  ALWAYS_ALLOWED,
  getUserPermissions,
  saveUserPermissions,
  clearUserPermissions,
  getAllPermissionsMap,
  getSessionIdentity,
  checkSessionMenuOverride
};
