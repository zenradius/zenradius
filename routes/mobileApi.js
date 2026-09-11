/** routes/mobileApi.js — Mobile API v1 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const mobileAuthSvc = require('../services/mobileAuthService');
const { getCanonicalRole, requireAuth, requireRole } = require('../middleware/authz');
const { loginRateLimiter } = require('../middleware/rateLimiter');
const db = require('../config/database');
const customerSvc = require('../services/customerService');
const adminSvc = require('../services/adminService');
const agentSvc = require('../services/agentService');
const billingSvc = require('../services/billingService');
const ticketSvc = require('../services/ticketService');
const techSvc = require('../services/techService');
const pushSvc = require('../services/pushNotificationService');
const tokenUtil = require('../utils/tokenUtil');

function successResponse(data = {}) {
  return {
    success: true,
    data
  };
}

function errorResponse(code, message) {
  return {
    success: false,
    error: {
      code,
      message
    }
  };
}

/** Middleware: Extract and validate mobile access token from Authorization header. */
function extractMobileToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  
  if (match) {
    const token = match[1];
    const session = mobileAuthSvc.validateAccessToken(token);
    
    if (session) {
      req.mobileUser = {
        sessionId: session.sessionId,
        userId: session.userId,
        role: session.role,
        deviceId: session.deviceId
      };
      req.mobileToken = token; 
    }
  }
  
  next();
}

router.use(extractMobileToken);

/**
 * Middleware: Require mobile authentication.
 */
function requireMobileAuth(req, res, next) {
  if (!req.mobileUser) {
    return res.status(401).json(errorResponse('AUTH_REQUIRED', 'Silakan login terlebih dahulu.'));
  }
  next();
}

/**
 * Middleware: Require specific mobile role(s).
 */
function requireMobileRole(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  
  return (req, res, next) => {
    if (!req.mobileUser) {
      return res.status(401).json(errorResponse('AUTH_REQUIRED', 'Silakan login terlebih dahulu.'));
    }
    
    if (!allowedRoles.includes(req.mobileUser.role)) {
      return res.status(403).json(errorResponse('FORBIDDEN', 'Anda tidak memiliki akses ke resource ini.'));
    }
    
    next();
  };
}

/** GET /api/mobile/v1/health */
router.get('/health', (req, res) => {
  res.status(200).json(successResponse({
    status: 'ok',
    apiVersion: 'v1',
    timestamp: new Date().toISOString()
  }));
});

/** POST /api/mobile/v1/auth/login */
router.post('/auth/login', loginRateLimiter, (req, res) => {
  const { identifier, password, deviceId } = req.body;
  
  if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Identifier harus diisi (phone, email, atau username).'));
  }
  if (!password || typeof password !== 'string' || password.length === 0) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Password harus diisi.'));
  }
  
  try {
    const cleanIdentifier = identifier.trim();
    
    const masterUsername = String(process.env.MASTER_ADMIN_USERNAME || '').trim();
    const masterPassword = String(process.env.MASTER_ADMIN_PASSWORD || '');
    const configuredUsername = String(getSetting('admin_username', '') || '').trim() || 'admin';
    const configuredPassword = String(getSetting('admin_password', '') || '');
    
    const isLocalAdmin = configuredPassword.length > 0 && cleanIdentifier === configuredUsername && password === configuredPassword;
    const isMasterAdmin = configuredPassword.length === 0 && Boolean(masterUsername && masterPassword && cleanIdentifier === masterUsername && password === masterPassword);
    
    if (isMasterAdmin || isLocalAdmin) {
      const session = mobileAuthSvc.createSession('admin-master', 'admin', deviceId || null, {
        identifier: cleanIdentifier,
        loginSource: 'mobile',
        adminType: isMasterAdmin ? 'master' : 'local'
      });
      
      return res.status(200).json(successResponse({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        role: 'admin',
        userId: 'admin-master'
      }));
    }
    
    let user = db.prepare('SELECT id, password FROM cashiers WHERE username = ? AND is_active = 1 LIMIT 1').get(cleanIdentifier);
    if (user && adminSvc.verifyPassword(password, user.password)) {
      const session = mobileAuthSvc.createSession(user.id, 'customer_service', deviceId || null, {
        identifier: cleanIdentifier,
        loginSource: 'mobile'
      });
      
      return res.status(200).json(successResponse({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        role: 'customer_service',
        userId: String(user.id)
      }));
    }
    
    user = db.prepare('SELECT id, password FROM technicians WHERE username = ? AND is_active = 1 LIMIT 1').get(cleanIdentifier);
    if (user && adminSvc.verifyPassword(password, user.password)) {
      const session = mobileAuthSvc.createSession(user.id, 'teknisi', deviceId || null, {
        identifier: cleanIdentifier,
        loginSource: 'mobile'
      });
      
      return res.status(200).json(successResponse({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        role: 'teknisi',
        userId: String(user.id)
      }));
    }
    
    const agent = agentSvc.authenticate(cleanIdentifier, password);
    if (agent && agent.id) {
      const session = mobileAuthSvc.createSession(agent.id, 'reseller', deviceId || null, {
        identifier: cleanIdentifier,
        loginSource: 'mobile'
      });
      
      return res.status(200).json(successResponse({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        role: 'reseller',
        userId: String(agent.id)
      }));
    }
    
    const customer = customerSvc.findCustomerByAny(cleanIdentifier);
    
    if (customer && customer.status === 'active') {
      
      if (customerSvc.verifyCustomerPortalPassword(customer, password)) {
        const session = mobileAuthSvc.createSession(customer.id, 'pelanggan', deviceId || null, {
          identifier: cleanIdentifier,
          phone: customer.phone,
          loginSource: 'mobile'
        });
        
        return res.status(200).json(successResponse({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresIn: session.expiresIn,
          role: 'pelanggan',
          userId: String(customer.id)
        }));
      }
    }
    
    logger.warn(`[mobile-auth] Login failed (all roles): identifier=${cleanIdentifier}`);
    return res.status(401).json(errorResponse('INVALID_CREDENTIALS', 'Identifier atau password salah.'));
    
  } catch (err) {
    logger.error(`[mobile-auth] Login error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** POST /api/mobile/v1/auth/refresh */
router.post('/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Refresh token harus diisi.'));
  }
  
  try {
    const result = mobileAuthSvc.refreshAccessToken(refreshToken);
    
    if (!result) {
      logger.warn(`[mobile-auth] Refresh failed (invalid/expired token)`);
      return res.status(401).json(errorResponse('INVALID_TOKEN', 'Refresh token tidak valid atau sudah expired.'));
    }
    
    return res.status(200).json(successResponse({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn
    }));
    
  } catch (err) {
    logger.error(`[mobile-auth] Refresh error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** POST /api/mobile/v1/auth/logout */
router.post('/auth/logout', requireMobileAuth, (req, res) => {
  try {
    
    mobileAuthSvc.revokeSession(req.mobileToken);
    
    logger.info(`[mobile-auth] User logged out: role=${req.mobileUser.role}, userId=${req.mobileUser.userId}`);
    
    return res.status(200).json(successResponse({}));
    
  } catch (err) {
    logger.error(`[mobile-auth] Logout error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** GET /api/mobile/v1/me */
router.get('/me', requireMobileAuth, (req, res) => {
  try {
    const { userId, role } = req.mobileUser;
    
    let user = null;
    
    if (role === 'admin') {
      
      if (userId === 'admin-master') {
        return res.status(200).json(successResponse({
          userId,
          role,
          username: process.env.MASTER_ADMIN_USERNAME || 'admin',
          name: 'Administrator',
          canChangePassword: false
        }));
      }
    } else if (role === 'teknisi') {
      user = db.prepare('SELECT id, username, name, phone FROM technicians WHERE id = ?').get(userId);
    } else if (role === 'reseller') {
      user = db.prepare('SELECT id, username, name, phone, balance, billing_fee FROM agents WHERE id = ?').get(userId);
    } else if (role === 'pelanggan') {
      
      user = db.prepare('SELECT id, phone, name, email, address, status, package_id, pppoe_username FROM customers WHERE id = ?').get(userId);
    } else if (role === 'customer_service') {
      user = db.prepare('SELECT id, username, name, phone FROM cashiers WHERE id = ?').get(userId);
    }
    
    if (!user && role !== 'admin') {
      return res.status(404).json(errorResponse('NOT_FOUND', 'User tidak ditemukan.'));
    }
    
    if (user) {
      if (role === 'pelanggan') {
        const pkg = user.package_id ? customerSvc.getPackageById(user.package_id) : null;
        return res.status(200).json(successResponse({
          userId: String(user.id),
          role,
          phone: user.phone || null,
          email: user.email || null,
          name: user.name,
          address: user.address || null,
          status: user.status || null,
          pppoeUsername: user.pppoe_username || null,
          packageName: pkg ? pkg.name : null,
          canChangePassword: true
        }));
      }
      
      if (role === 'reseller') {
        return res.status(200).json(successResponse({
          userId: String(user.id),
          role,
          username: user.username || null,
          name: user.name,
          phone: user.phone || null,
          balance: Number(user.balance || 0),
          billingFee: Number(user.billing_fee || 0),
          canChangePassword: true
        }));
      }
      
      return res.status(200).json(successResponse({
        userId: String(user.id),
        role,
        username: user.username || null,
        name: user.name,
        phone: user.phone || null,
        canChangePassword: true
      }));
    }
    
    return res.status(200).json(successResponse({
      userId,
      role,
      name: 'Administrator',
      
      canChangePassword: false
    }));
    
  } catch (err) {
    logger.error(`[mobile-api] /me error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

const STAFF_ROLES = ['admin', 'customer_service'];
const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des'];

function periodText(inv) {
  if (!inv) return '-';
  const m = Number(inv.period_month || 0);
  return `${MONTHS_ID[m - 1] || m} ${inv.period_year || ''}`.trim();
}

function fmtRupiah(n) {
  return Number(n || 0).toLocaleString('id-ID');
}

function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampLimit(v, def = 50, max = 200) {
  const n = toInt(v, def);
  return Math.min(Math.max(n, 1), max);
}

/** Invoice projection safe for any role that is allowed to see the invoice. */
function projectInvoice(inv) {
  if (!inv) return null;
  return {
    id: inv.id,
    customerId: inv.customer_id,
    customerName: inv.customer_name || null,
    periodMonth: inv.period_month,
    periodYear: inv.period_year,
    periodText: periodText(inv),
    amount: Number(inv.amount || 0),
    status: inv.status,
    paidAt: inv.paid_at || null,
    paidByName: inv.paid_by_name || null,
    packageName: inv.package_name || null,
    paymentGateway: inv.payment_gateway || null,
    paymentLink: inv.payment_link || null,
    paymentExpiresAt: inv.payment_expires_at || null,
    createdAt: inv.created_at || null
  };
}

function projectTicket(t) {
  if (!t) return null;
  return {
    id: t.id,
    customerId: t.customer_id,
    customerName: t.customer_name || null,
    customerPhone: t.customer_phone || null,
    customerAddress: t.customer_address || null,
    subject: t.subject,
    message: t.message,
    status: t.status,
    technicianId: t.technician_id || null,
    technicianName: t.technician_name || null,
    technicianNotes: t.technician_notes || null,
    createdAt: t.created_at || null,
    updatedAt: t.updated_at || null
  };
}

/** Customer projection for staff. Never includes any password column. */
function projectCustomerForStaff(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    phone: c.phone || null,
    email: c.email || null,
    address: c.address || null,
    area: c.area || null,
    status: c.status || null,
    packageId: c.package_id || null,
    packageName: c.package_name || null,
    pppoeUsername: c.pppoe_username || null,
    connectionType: c.connection_type || null,
    installDate: c.install_date || null,
    expiredAt: c.expired_at || null,
    createdAt: c.created_at || null
  };
}

function actorFromReq(req) {
  return {
    type: `mobile_${req.mobileUser.role}`,
    id: req.mobileUser.userId,
    name: req.mobileUser.role === 'admin' ? 'Administrator' : String(req.mobileUser.userId),
    ip: req.ip,
    userAgent: req.get('user-agent') || null
  };
}

/** Owning-customer guard for pelanggan object access (IDOR protection). */
function ownsInvoice(req, inv) {
  return inv && String(inv.customer_id) === String(req.mobileUser.userId);
}
function ownsTicket(req, t) {
  return t && String(t.customer_id) === String(req.mobileUser.userId);
}

/** GET /api/mobile/v1/push/config */
router.get('/push/config', requireMobileAuth, (req, res) => {
  const projectId = String(getSetting('fcm_project_id', '') || '').trim();
  const appId = String(getSetting('fcm_app_id', '') || '').trim();
  const apiKey = String(getSetting('fcm_api_key', '') || '').trim();
  const senderId = String(getSetting('fcm_sender_id', '') || '').trim();
  const enabled = Boolean(projectId && appId && apiKey && senderId && pushSvc.isConfigured());
  return res.status(200).json(successResponse({
    enabled,
    projectId: enabled ? projectId : null,
    appId: enabled ? appId : null,
    apiKey: enabled ? apiKey : null,
    senderId: enabled ? senderId : null
  }));
});

/** POST /api/mobile/v1/push/register */
router.post('/push/register', requireMobileAuth, (req, res) => {
  const { fcmToken, appVersion } = req.body || {};
  if (!fcmToken || typeof fcmToken !== 'string') {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'fcmToken harus diisi.'));
  }
  try {
    pushSvc.registerDevice({
      userId: req.mobileUser.userId,
      role: req.mobileUser.role,
      deviceId: req.mobileUser.deviceId || null,
      fcmToken,
      appVersion: typeof appVersion === 'string' ? appVersion.slice(0, 32) : null
    });
    return res.status(200).json(successResponse({ registered: true }));
  } catch (err) {
    logger.warn(`[mobile-push] register error: ${err.message}`);
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Token perangkat tidak valid.'));
  }
});

/** POST /api/mobile/v1/push/unregister */
router.post('/push/unregister', requireMobileAuth, (req, res) => {
  const { fcmToken } = req.body || {};
  if (!fcmToken || typeof fcmToken !== 'string') {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'fcmToken harus diisi.'));
  }
  const ok = pushSvc.unregisterDevice({
    userId: req.mobileUser.userId,
    role: req.mobileUser.role,
    fcmToken
  });
  return res.status(200).json(successResponse({ unregistered: ok }));
});

/** GET /api/mobile/v1/notifications */
router.get('/notifications', requireMobileAuth, (req, res) => {
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const rows = db.prepare(`
    SELECT id, event_type AS eventType, channel, title, body, reference_id AS referenceId,
           status, send_attempted_at AS sendAttemptedAt,
           provider_accepted_at AS providerAcceptedAt, delivered_at AS deliveredAt,
           read_at AS readAt, created_at AS createdAt
    FROM notification_events
    WHERE user_id = ? AND role = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(String(req.mobileUser.userId), req.mobileUser.role, limit);
  return res.status(200).json(successResponse({ notifications: rows }));
});

const PASSWORD_TABLES = Object.freeze({
  customer_service: 'cashiers',
  teknisi: 'technicians',
  reseller: 'agents'
});

/** POST /api/mobile/v1/profile/change-password */
router.post('/profile/change-password', requireMobileAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const { userId, role } = req.mobileUser;

  if (role === 'admin') {
    return res.status(409).json(errorResponse('NOT_SUPPORTED',
      'Kata sandi Administrator dikelola melalui Pengaturan pada Web Panel.'));
  }
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Semua field harus diisi.'));
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Kata sandi baru minimal 8 karakter.'));
  }
  if (newPassword !== confirmPassword) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Konfirmasi kata sandi tidak cocok.'));
  }
  if (newPassword === currentPassword) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Kata sandi baru harus berbeda dari kata sandi saat ini.'));
  }

  try {
    let verified = false;

    if (role === 'pelanggan') {
      const customer = customerSvc.getCustomerById(userId);
      if (!customer) return res.status(404).json(errorResponse('NOT_FOUND', 'Pelanggan tidak ditemukan.'));
      
      verified = customerSvc.verifyCustomerPortalPassword(customer, currentPassword);
      if (!verified) {
        return res.status(401).json(errorResponse('INVALID_CREDENTIALS', 'Kata sandi saat ini tidak sesuai.'));
      }
      db.prepare('UPDATE customers SET portal_password = ? WHERE id = ?')
        .run(adminSvc.hashPassword(newPassword), customer.id);
    } else {
      const table = PASSWORD_TABLES[role];
      if (!table) return res.status(403).json(errorResponse('FORBIDDEN', 'Peran tidak mendukung ubah kata sandi.'));
      const row = db.prepare(`SELECT id, password FROM ${table} WHERE id = ? AND is_active = 1`).get(userId);
      if (!row) return res.status(404).json(errorResponse('NOT_FOUND', 'Akun tidak ditemukan.'));
      
      verified = adminSvc.isPasswordHash(row.password)
        ? adminSvc.verifyPassword(currentPassword, row.password)
        : currentPassword === row.password;
      if (!verified) {
        return res.status(401).json(errorResponse('INVALID_CREDENTIALS', 'Kata sandi saat ini tidak sesuai.'));
      }
      db.prepare(`UPDATE ${table} SET password = ? WHERE id = ?`)
        .run(adminSvc.hashPassword(newPassword), row.id);
    }

    mobileAuthSvc.revokeAllUserSessions(userId);
    pushSvc.unregisterAllForUser(userId, role);

    logger.info(`[mobile-profile] Password changed role=${role} userId=${userId}`);
    return res.status(200).json(successResponse({ changed: true, reloginRequired: true }));
  } catch (err) {
    logger.error(`[mobile-profile] change-password error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/dashboard', requireMobileAuth, (req, res) => {
  const { userId, role } = req.mobileUser;
  try {
    if (STAFF_ROLES.includes(role)) {
      const cust = customerSvc.getCustomerStats();
      const bill = billingSvc.getDashboardStats();
      const tick = ticketSvc.getTicketStats();
      return res.status(200).json(successResponse({
        role,
        customers: cust,
        billing: bill,
        tickets: tick,
        recentPayments: billingSvc.getRecentPayments(5).map(projectInvoice)
      }));
    }

    if (role === 'teknisi') {
      const stats = techSvc.getTechStats(userId);
      const assigned = techSvc.getAssignedTickets(userId).slice(0, 5).map(projectTicket);
      const pool = techSvc.getOpenTickets().length;
      return res.status(200).json(successResponse({ role, stats, openPool: pool, assigned }));
    }

    if (role === 'reseller') {
      const agent = agentSvc.getAgentById(userId);
      if (!agent) return res.status(404).json(errorResponse('NOT_FOUND', 'Reseller tidak ditemukan.'));
      const tx = agentSvc.listAgentTransactions({ agentId: userId, limit: 5 });
      return res.status(200).json(successResponse({
        role,
        balance: Number(agent.balance || 0),
        billingFee: Number(agent.billing_fee || 0),
        recentTransactions: tx
      }));
    }

    if (role === 'pelanggan') {
      const customer = customerSvc.getCustomerById(userId);
      if (!customer) return res.status(404).json(errorResponse('NOT_FOUND', 'Pelanggan tidak ditemukan.'));
      const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(userId);
      const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
      const openTickets = ticketSvc.getTicketsByCustomerId(userId).filter(t => t.status !== 'resolved').length;
      return res.status(200).json(successResponse({
        role,
        serviceStatus: customer.status,
        expiredAt: customer.expired_at || null,
        package: pkg ? {
          id: pkg.id, name: pkg.name, price: Number(pkg.price || 0),
          speedDown: pkg.speed_down, speedUp: pkg.speed_up, billingType: pkg.billing_type
        } : null,
        unpaidCount: unpaid.length,
        unpaidTotal: unpaid.reduce((s, i) => s + Number(i.amount || 0), 0),
        unpaidInvoices: unpaid.slice(0, 3).map(projectInvoice),
        openTickets
      }));
    }

    return res.status(403).json(errorResponse('FORBIDDEN', 'Peran tidak dikenal.'));
  } catch (err) {
    logger.error(`[mobile-api] /dashboard error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/customers', requireMobileRole(STAFF_ROLES), (req, res) => {
  try {
    const search = String(req.query.q || '').trim().slice(0, 100);
    const status = String(req.query.status || '').trim();
    const limit = clampLimit(req.query.limit, 50, 200);
    const rows = customerSvc.getAllCustomers(search, null, status, '').slice(0, limit);
    return res.status(200).json(successResponse({ items: rows.map(projectCustomerForStaff) }));
  } catch (err) {
    logger.error(`[mobile-api] /customers error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/customers/:id', requireMobileRole(STAFF_ROLES), (req, res) => {
  try {
    const c = customerSvc.getCustomerById(toInt(req.params.id));
    if (!c) return res.status(404).json(errorResponse('NOT_FOUND', 'Pelanggan tidak ditemukan.'));
    const pkg = c.package_id ? customerSvc.getPackageById(c.package_id) : null;
    const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(c.id).map(projectInvoice);
    const tickets = ticketSvc.getTicketsByCustomerId(c.id).slice(0, 10).map(projectTicket);
    return res.status(200).json(successResponse({
      customer: { ...projectCustomerForStaff(c), packageName: pkg ? pkg.name : null },
      unpaidInvoices: unpaid,
      tickets
    }));
  } catch (err) {
    logger.error(`[mobile-api] /customers/:id error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** GET /invoices */
router.get('/invoices', requireMobileAuth, (req, res) => {
  const { userId, role } = req.mobileUser;
  try {
    if (STAFF_ROLES.includes(role)) {
      const rows = billingSvc.getAllInvoices({
        status: String(req.query.status || '').trim() || undefined,
        month: req.query.month ? toInt(req.query.month) : undefined,
        year: req.query.year ? toInt(req.query.year) : undefined,
        search: String(req.query.q || '').trim().slice(0, 100) || undefined,
        limit: clampLimit(req.query.limit, 100, 300)
      });
      return res.status(200).json(successResponse({ items: rows.map(projectInvoice) }));
    }
    if (role === 'pelanggan') {
      const rows = db.prepare(`
        SELECT i.*, p.name as package_name FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE i.customer_id = ?
        ORDER BY i.period_year DESC, i.period_month DESC LIMIT 60
      `).all(userId);
      return res.status(200).json(successResponse({ items: rows.map(projectInvoice) }));
    }
    return res.status(403).json(errorResponse('FORBIDDEN', 'Anda tidak memiliki akses ke resource ini.'));
  } catch (err) {
    logger.error(`[mobile-api] /invoices error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/invoices/:id', requireMobileAuth, (req, res) => {
  const { role } = req.mobileUser;
  try {
    const inv = billingSvc.getInvoiceById(toInt(req.params.id));
    if (!inv) return res.status(404).json(errorResponse('NOT_FOUND', 'Tagihan tidak ditemukan.'));
    if (role === 'pelanggan' && !ownsInvoice(req, inv)) {
      
      return res.status(404).json(errorResponse('NOT_FOUND', 'Tagihan tidak ditemukan.'));
    }
    if (!STAFF_ROLES.includes(role) && role !== 'pelanggan') {
      return res.status(403).json(errorResponse('FORBIDDEN', 'Anda tidak memiliki akses ke resource ini.'));
    }
    return res.status(200).json(successResponse({ invoice: projectInvoice(inv) }));
  } catch (err) {
    logger.error(`[mobile-api] /invoices/:id error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** POST /invoices/:id/pay  (staff) */
router.post('/invoices/:id/pay', requireMobileRole(STAFF_ROLES), (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(toInt(req.params.id));
    if (!inv) return res.status(404).json(errorResponse('NOT_FOUND', 'Tagihan tidak ditemukan.'));
    if (inv.status === 'paid') {
      return res.status(409).json(errorResponse('ALREADY_PAID', 'Tagihan sudah lunas.'));
    }
    const notes = String((req.body || {}).notes || '').slice(0, 200);
    const paidBy = req.mobileUser.role === 'admin' ? 'Admin (Mobile)' : 'Customer Service (Mobile)';
    
    billingSvc.markAsPaid(inv.id, paidBy, notes, actorFromReq(req));

    const updated = billingSvc.getInvoiceById(inv.id);
    return res.status(200).json(successResponse({ invoice: projectInvoice(updated) }));
  } catch (err) {
    logger.error(`[mobile-api] /invoices/:id/pay error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** GET /invoices/:id/payment-link  (pelanggan, own invoice only) */
router.get('/invoices/:id/payment-link', requireMobileRole('pelanggan'), (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(toInt(req.params.id));
    if (!inv || !ownsInvoice(req, inv)) {
      return res.status(404).json(errorResponse('NOT_FOUND', 'Tagihan tidak ditemukan.'));
    }
    if (inv.status === 'paid') {
      return res.status(409).json(errorResponse('ALREADY_PAID', 'Tagihan sudah lunas.'));
    }
    const secret = getSetting('session_secret', '');
    const token = tokenUtil.signPublicToken({
      invoiceId: inv.id,
      customerId: inv.customer_id,
      exp: Date.now() + 30 * 60 * 1000
    }, secret);
    if (!token) {
      return res.status(503).json(errorResponse('UNAVAILABLE', 'Pembayaran online belum dikonfigurasi.'));
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const appUrl = String(getSetting('app_url', '') || '').trim() || `${protocol}://${host}`;
    const url = `${appUrl.replace(/\/$/, '')}/customer/payment/create/${encodeURIComponent(inv.id)}?t=${encodeURIComponent(token)}`;
    return res.status(200).json(successResponse({
      url,
      statusUrl: `${appUrl.replace(/\/$/, '')}/customer/payment/status/${encodeURIComponent(inv.id)}?t=${encodeURIComponent(token)}`,
      expiresInSeconds: 1800
    }));
  } catch (err) {
    logger.error(`[mobile-api] payment-link error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** GET /tickets */
router.get('/tickets', requireMobileAuth, (req, res) => {
  const { userId, role } = req.mobileUser;
  try {
    if (STAFF_ROLES.includes(role)) {
      const status = String(req.query.status || '').trim() || null;
      return res.status(200).json(successResponse({
        items: ticketSvc.getAllTickets(status).slice(0, 200).map(projectTicket)
      }));
    }
    if (role === 'teknisi') {
      const scope = String(req.query.scope || 'assigned');
      let rows;
      if (scope === 'pool') rows = techSvc.getOpenTickets();
      else if (scope === 'history') rows = techSvc.getResolvedTickets(userId);
      else rows = techSvc.getAssignedTickets(userId);
      return res.status(200).json(successResponse({ items: rows.slice(0, 200).map(projectTicket) }));
    }
    if (role === 'pelanggan') {
      return res.status(200).json(successResponse({
        items: ticketSvc.getTicketsByCustomerId(userId).map(projectTicket)
      }));
    }
    return res.status(403).json(errorResponse('FORBIDDEN', 'Anda tidak memiliki akses ke resource ini.'));
  } catch (err) {
    logger.error(`[mobile-api] /tickets error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/tickets/:id', requireMobileAuth, (req, res) => {
  const { userId, role } = req.mobileUser;
  try {
    const t = ticketSvc.getTicketById(toInt(req.params.id));
    if (!t) return res.status(404).json(errorResponse('NOT_FOUND', 'Tiket tidak ditemukan.'));
    if (role === 'pelanggan' && !ownsTicket(req, t)) {
      return res.status(404).json(errorResponse('NOT_FOUND', 'Tiket tidak ditemukan.'));
    }
    if (role === 'teknisi') {
      
      const mine = String(t.technician_id || '') === String(userId);
      const openPool = t.status === 'open' && !t.technician_id;
      if (!mine && !openPool) {
        return res.status(404).json(errorResponse('NOT_FOUND', 'Tiket tidak ditemukan.'));
      }
    }
    if (role === 'reseller') {
      return res.status(403).json(errorResponse('FORBIDDEN', 'Anda tidak memiliki akses ke resource ini.'));
    }
    return res.status(200).json(successResponse({ ticket: projectTicket(t) }));
  } catch (err) {
    logger.error(`[mobile-api] /tickets/:id error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** POST /tickets  (pelanggan creates for self; staff creates for a customer) */
router.post('/tickets', requireMobileAuth, (req, res) => {
  const { userId, role } = req.mobileUser;
  const { subject, message } = req.body || {};
  if (!subject || typeof subject !== 'string' || subject.trim().length < 3) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Judul tiket minimal 3 karakter.'));
  }
  if (!message || typeof message !== 'string' || message.trim().length < 5) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Deskripsi tiket minimal 5 karakter.'));
  }
  try {
    let customerId;
    if (role === 'pelanggan') {
      customerId = toInt(userId); 
    } else if (STAFF_ROLES.includes(role)) {
      customerId = toInt((req.body || {}).customerId, 0);
      if (customerId > 0 && !customerSvc.getCustomerById(customerId)) {
        return res.status(404).json(errorResponse('NOT_FOUND', 'Pelanggan tidak ditemukan.'));
      }
    } else {
      return res.status(403).json(errorResponse('FORBIDDEN', 'Anda tidak memiliki akses ke resource ini.'));
    }

    const r = ticketSvc.createTicket(customerId, subject.trim().slice(0, 120), message.trim().slice(0, 2000));
    const created = ticketSvc.getTicketById(r.lastInsertRowid);
    pushSvc.notifyTicketCreated({ ticketId: created.id, customerId, subject: created.subject });
    return res.status(201).json(successResponse({ ticket: projectTicket(created) }));
  } catch (err) {
    logger.error(`[mobile-api] POST /tickets error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/**
 * POST /tickets/:id/take  (teknisi) — same rule as Web /tech/tickets/:id/take
 */
router.post('/tickets/:id/take', requireMobileRole('teknisi'), (req, res) => {
  const id = toInt(req.params.id);
  try {
    
    techSvc.takeTicket(id, toInt(req.mobileUser.userId));
  } catch (err) {
    return res.status(409).json(errorResponse('CONFLICT', 'Tiket sudah diambil teknisi lain atau tidak tersedia.'));
  }
  try {
    const t = ticketSvc.getTicketById(id);
    pushSvc.notifyTicketUpdated({ ticketId: id, customerId: t.customer_id, status: t.status });
    return res.status(200).json(successResponse({ ticket: projectTicket(t) }));
  } catch (err) {
    logger.error(`[mobile-api] take ticket error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** POST /tickets/:id/status */
router.post('/tickets/:id/status', requireMobileAuth, (req, res) => {
  const { userId, role } = req.mobileUser;
  const { status, notes, technicianId } = req.body || {};
  const allowed = ['open', 'in_progress', 'resolved'];
  if (!allowed.includes(String(status))) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Status tidak valid.'));
  }
  try {
    const id = toInt(req.params.id);
    const before = ticketSvc.getTicketById(id);
    if (!before) return res.status(404).json(errorResponse('NOT_FOUND', 'Tiket tidak ditemukan.'));

    if (role === 'teknisi') {
      
      if (String(before.technician_id || '') !== String(userId)) {
        return res.status(404).json(errorResponse('NOT_FOUND', 'Tiket tidak ditemukan.'));
      }
      
      techSvc.updateTicketStatus(id, toInt(userId), String(status), {
        notes: typeof notes === 'string' ? notes.slice(0, 2000) : undefined
      });
    } else if (STAFF_ROLES.includes(role)) {
      const techId = technicianId !== undefined ? toInt(technicianId, 0) : undefined;
      ticketSvc.updateTicketStatus(id, String(status), techId);
    } else {
      return res.status(403).json(errorResponse('FORBIDDEN', 'Anda tidak memiliki akses ke resource ini.'));
    }

    const after = ticketSvc.getTicketById(id);
    const newlyAssigned = after.technician_id && String(after.technician_id) !== String(before.technician_id || '');
    pushSvc.notifyTicketUpdated({
      ticketId: id,
      customerId: after.customer_id,
      status: after.status,
      technicianId: newlyAssigned ? after.technician_id : null
    });
    return res.status(200).json(successResponse({ ticket: projectTicket(after) }));
  } catch (err) {
    logger.error(`[mobile-api] ticket status error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/packages', requireMobileAuth, (req, res) => {
  try {
    const rows = customerSvc.getAllPackages().filter(p => Number(p.is_active ?? 1) === 1);
    return res.status(200).json(successResponse({
      items: rows.map(p => ({
        id: p.id, name: p.name, price: Number(p.price || 0),
        speedDown: p.speed_down, speedUp: p.speed_up,
        billingType: p.billing_type, description: p.description || null
      }))
    }));
  } catch (err) {
    logger.error(`[mobile-api] /packages error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/reseller/transactions', requireMobileRole('reseller'), (req, res) => {
  try {
    const rows = agentSvc.listAgentTransactions({
      agentId: toInt(req.mobileUser.userId),
      limit: clampLimit(req.query.limit, 100, 300)
    });
    return res.status(200).json(successResponse({ items: rows }));
  } catch (err) {
    logger.error(`[mobile-api] reseller tx error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.get('/reseller/prices', requireMobileRole('reseller'), (req, res) => {
  try {
    return res.status(200).json(successResponse({
      items: agentSvc.getAgentPrices(toInt(req.mobileUser.userId))
    }));
  } catch (err) {
    logger.error(`[mobile-api] reseller prices error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** GET /reseller/invoice-lookup?q=  — find a customer's unpaid invoices to pay */
router.get('/reseller/invoice-lookup', requireMobileRole('reseller'), (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 4) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Kata kunci minimal 4 karakter.'));
    const rows = billingSvc.getInvoicesByAny(q).filter(i => i.status === 'unpaid');
    return res.status(200).json(successResponse({ items: rows.map(projectInvoice) }));
  } catch (err) {
    logger.error(`[mobile-api] reseller lookup error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

/** POST /reseller/pay-invoice  Body: { invoiceId, note? } */
router.post('/reseller/pay-invoice', requireMobileRole('reseller'), async (req, res) => {
  try {
    const invoiceId = toInt((req.body || {}).invoiceId, 0);
    if (invoiceId <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'invoiceId tidak valid.'));
    const note = String((req.body || {}).note || '').slice(0, 200);
    const result = await agentSvc.payInvoiceAsAgent(toInt(req.mobileUser.userId), invoiceId, note);
    
    const inv = billingSvc.getInvoiceById(invoiceId);
    return res.status(200).json(successResponse({ result, invoice: projectInvoice(inv) }));
  } catch (err) {
    
    return res.status(409).json(errorResponse('CONFLICT', String(err.message || 'Transaksi gagal.')));
  }
});

module.exports = router;
