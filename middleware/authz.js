/**
 * middleware/authz.js — Centralized RBAC untuk ZenRadius (Phase 3)
 *
 * ARSITEKTUR: ONE ISP = ONE INSTANCE (bukan multi-tenant).
 * Enam canonical role (stable, lowercase, disimpan di session sebagai req.session.role):
 *   admin            — Administrator Sistem / System Administrator
 *   customer_service  — Kasir / Cashier
 *   kolektor          — Kolektor Lapangan / Field Collector
 *   teknisi           — Teknisi Lapangan / Field Technician
 *   reseller          — Reseller Resmi / Authorized Reseller
 *   pelanggan         — Pelanggan / Subscriber
 *
 * KEPUTUSAN ARSITEKTUR (didokumentasikan, bukan diam-diam):
 * Repo TIDAK memiliki generic `users` table — setiap portal (admin/cashier/
 * technician/agent/collector/customer) punya tabel kredensial sendiri dengan
 * password hash (PBKDF2, lihat services/adminService.js Phase 2). Membuat
 * `users` table terpusat sekarang berarti migrasi destruktif/berisiko
 * (menyatukan 6 tabel independen) tanpa manfaat keamanan langsung.
 * Maka Phase 3 TIDAK membuat tabel baru; sebagai gantinya setiap login
 * mengisi `req.session.role` dengan canonical role (single source of truth
 * untuk authorization), sementara legacy boolean flags (isAdmin, isCashier,
 * dst) dipertahankan sebagai compatibility layer (DEPRECATED, jangan
 * dipakai untuk authorization BARU).
 *
 * Authorization = AUTHENTICATION + ROLE + OBJECT OWNERSHIP.
 * Modul ini hanya menangani dua yang pertama; ownership tetap dicek per-route
 * (lihat requireOwnCustomer di bawah untuk pola object-level check).
 */

const CANONICAL_ROLES = Object.freeze([
  'admin',
  'customer_service',
  'kolektor',
  'teknisi',
  'reseller',
  'pelanggan'
]);

function isValidRole(role) {
  return CANONICAL_ROLES.includes(String(role || '').trim().toLowerCase());
}

/**
 * Mapping legacy → canonical (dipakai HANYA di titik login, tidak pernah
 * dipercaya dari request/body/query).
 */
const LEGACY_TO_CANONICAL = Object.freeze({
  isAdmin: 'admin',
  isCashier: 'customer_service',
  isTechnician: 'teknisi',
  isAgent: 'reseller',
  isCollector: 'kolektor', // role sendiri, terpisah dari Kasir (customer_service)
  isCustomer: 'pelanggan'
});

/**
 * Ambil canonical role dari session. Tidak pernah membaca dari body/query.
 * Fail-closed: role tidak dikenal / session kosong → null (DENY).
 */
function getCanonicalRole(session) {
  if (!session) return null;

  // Sumber utama: field eksplisit yang diisi saat login (Phase 3+).
  const explicit = String(session.role || '').trim().toLowerCase();
  if (isValidRole(explicit)) return explicit;

  // Compatibility layer: derive dari legacy flags (DEPRECATED — jangan
  // dijadikan basis untuk fitur/route baru).
  for (const [flag, role] of Object.entries(LEGACY_TO_CANONICAL)) {
    if (session[flag]) return role;
  }

  return null;
}

/**
 * Middleware: wajib authenticated (role apa pun yang valid).
 */
function requireAuth(req, res, next) {
  const role = getCanonicalRole(req.session);
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  req.canonicalRole = role;
  next();
}

/**
 * Middleware: wajib salah satu dari daftar role.
 * requireRole('admin') atau requireRole(['admin','customer_service'])
 * Fail-closed by default: unknown/missing role -> DENY.
 */
function requireRole(roles, options = {}) {
  const allowed = (Array.isArray(roles) ? roles : [roles]).map(r => String(r).trim().toLowerCase());
  const invalid = allowed.filter(r => !isValidRole(r));
  if (invalid.length) {
    throw new Error(`[authz] requireRole() menerima role tidak dikenal: ${invalid.join(', ')}`);
  }
  const redirectTo = options.redirectTo || null;

  return (req, res, next) => {
    const role = getCanonicalRole(req.session);
    if (!role || !allowed.includes(role)) {
      if (redirectTo) {
        if (req.session) req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke halaman ini.' };
        return res.redirect(redirectTo);
      }
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.canonicalRole = role;
    next();
  };
}

/**
 * Validasi role yang datang dari form/API (mis. saat Admin mengubah role user).
 * HARUS dipakai setiap kali menerima role dari client. Menolak role tidak dikenal.
 */
function assertValidRoleInput(roleInput) {
  const role = String(roleInput || '').trim().toLowerCase();
  if (!isValidRole(role)) {
    throw new Error(`Role tidak valid: ${roleInput}`);
  }
  return role;
}

module.exports = {
  CANONICAL_ROLES,
  isValidRole,
  getCanonicalRole,
  requireAuth,
  requireRole,
  assertValidRoleInput
};
