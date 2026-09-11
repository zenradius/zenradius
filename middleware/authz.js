/**
 * Centralized RBAC. Canonical role disimpan di req.session.role:
 * admin | customer_service (Kasir) | kolektor | teknisi | reseller | pelanggan.
 * Legacy flags (isAdmin, isCashier, ...) hanya compatibility layer — DEPRECATED.
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

/** Mapping legacy → canonical (dipakai HANYA di titik login, tidak pernah */
const LEGACY_TO_CANONICAL = Object.freeze({
  isAdmin: 'admin',
  isCashier: 'customer_service',
  isTechnician: 'teknisi',
  isAgent: 'reseller',
  isCollector: 'kolektor', 
  isCustomer: 'pelanggan'
});

/** Ambil canonical role dari session. Tidak pernah membaca dari body/query. */
function getCanonicalRole(session) {
  if (!session) return null;

  const explicit = String(session.role || '').trim().toLowerCase();
  if (isValidRole(explicit)) return explicit;

  // Compatibility layer: derive dari legacy flags (DEPRECATED — jangan
  
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

/** Middleware: wajib salah satu dari daftar role. */
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

/** Validasi role yang datang dari form/API (mis. saat Admin mengubah role user). */
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
