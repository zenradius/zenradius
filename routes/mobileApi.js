/** routes/mobileApi.js — Mobile API v1 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { logger } = require('../config/logger');
const { getSetting, getCurrentDateInTimezone } = require('../config/settingsManager');
const mobileAuthSvc = require('../services/mobileAuthService');
const { getCanonicalRole, requireAuth, requireRole } = require('../middleware/authz');
const { loginRateLimiter } = require('../middleware/rateLimiter');
const db = require('../config/database');
const customerSvc = require('../services/customerService');
const adminSvc = require('../services/adminService');
const agentSvc = require('../services/agentService');
const mikrotikService = require('../services/mikrotikService');
const billingSvc = require('../services/billingService');
const ticketSvc = require('../services/ticketService');
const techSvc = require('../services/techService');
const attendanceSvc = require('../services/attendanceService');
const auditSvc = require('../services/auditTrailService');
const { uploadAttendance, verifyAttendanceFileMagicBytes, removeAttendanceFile } = require('../middleware/attendanceUpload');
const sidebarMenuSvc = require('../services/sidebarMenuService');
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

    const collector = adminSvc.authenticateCollector(cleanIdentifier, password);
    if (collector && collector.id) {
      const session = mobileAuthSvc.createSession(collector.id, 'kolektor', deviceId || null, {
        identifier: cleanIdentifier,
        loginSource: 'mobile'
      });

      return res.status(200).json(successResponse({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        role: 'kolektor',
        userId: String(collector.id)
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

router.post('/auth/qr-login/approve', requireMobileRole('admin'), (req, res) => {
  const challenge = String((req.body || {}).challenge || '').trim();
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(challenge)) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'QR login tidak valid.'));
  }
  const session = mobileAuthSvc.getSessionInfo(req.mobileUser.sessionId);
  if (!session || session.role !== 'admin' || String(session.user_id) !== 'admin-master') {
    return res.status(403).json(errorResponse('FORBIDDEN', 'Hanya akun Administrator yang dapat menyetujui QR login.'));
  }

  let deviceInfo = {};
  try { deviceInfo = JSON.parse(session.device_info || '{}'); } catch (_) {}
  const adminUser = String(deviceInfo.identifier || process.env.MASTER_ADMIN_USERNAME || getSetting('admin_username', '') || 'admin').trim();
  const challengeHash = crypto.createHash('sha256').update(challenge).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE admin_qr_login_challenges
    SET status = 'approved', admin_user = ?, approved_at = ?
    WHERE challenge_hash = ? AND status = 'pending' AND expires_at > ?
  `).run(adminUser, now, challengeHash, now);

  if (!result.changes) {
    return res.status(409).json(errorResponse('QR_EXPIRED_OR_USED', 'QR sudah kedaluwarsa atau telah dipakai.'));
  }
  logger.info(`[admin-qr-login] Approved by mobile admin session=${req.mobileUser.sessionId}`);
  return res.status(200).json(successResponse({ approved: true, expiresIn: 120 }));
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
    } else if (role === 'kolektor') {
      user = db.prepare('SELECT id, username, name, phone, area FROM collectors WHERE id = ? AND is_active = 1').get(userId);
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

      if (role === 'kolektor') {
        return res.status(200).json(successResponse({
          userId: String(user.id),
          role,
          username: user.username || null,
          name: user.name,
          phone: user.phone || null,
          area: user.area || null,
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

function mobileAttendanceIdentity(req) {
  const isTechnician = req.mobileUser.role === 'teknisi';
  const employeeType = isTechnician ? 'technician' : 'cashier';
  const table = isTechnician ? 'technicians' : 'cashiers';
  const employee = db.prepare(`SELECT id, name, username FROM ${table} WHERE id = ? AND is_active = 1`)
    .get(toInt(req.mobileUser.userId));
  return employee ? { employeeType, employee } : null;
}

function projectAttendance(record) {
  if (!record) return null;
  return {
    id: record.id,
    status: record.status,
    checkInTime: record.check_in_time || null,
    checkInLat: record.check_in_lat || null,
    checkInLng: record.check_in_lng || null,
    checkInNote: record.check_in_note || null,
    checkInPhoto: record.check_in_photo || null,
    checkOutTime: record.check_out_time || null,
    checkOutLat: record.check_out_lat || null,
    checkOutLng: record.check_out_lng || null,
    checkOutNote: record.check_out_note || null,
    checkOutPhoto: record.check_out_photo || null,
    workDurationMinutes: Number(record.work_duration_minutes || 0)
  };
}

function requireMobileAttendanceMenu(req, res, next) {
  if (req.mobileUser.role === 'customer_service') {
    const access = sidebarMenuSvc.evaluateMenuAccess('cashier_attendance', {
      role: 'cashier',
      isCashier: true,
      cashierId: req.mobileUser.userId
    });
    if (!access.allowed) return res.status(403).json(errorResponse('FORBIDDEN', 'Menu absensi sedang dinonaktifkan.'));
  }
  if (req.mobileUser.role === 'teknisi') {
    const access = sidebarMenuSvc.evaluateMenuAccess('tech_attendance', {
      role: 'teknisi',
      isTechnician: true,
      techId: req.mobileUser.userId
    });
    if (!access.allowed) return res.status(403).json(errorResponse('FORBIDDEN', 'Menu absensi sedang dinonaktifkan.'));
  }
  next();
}

function mobileAttendanceUpload(req, res, next) {
  uploadAttendance.single('photo')(req, res, (uploadError) => {
    if (uploadError) {
      return res.status(400).json(errorResponse('INVALID_UPLOAD', uploadError.message || 'Foto absensi tidak valid.'));
    }
    verifyAttendanceFileMagicBytes(req, res, next);
  });
}

function readAttendanceCoordinates(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('Lokasi GPS tidak valid.');
  }
  return { lat: String(lat), lng: String(lng) };
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

function getActiveCollector(userId) {
  return db.prepare(`
    SELECT id, username, name, phone, area, auto_approve
    FROM collectors WHERE id = ? AND is_active = 1
  `).get(userId);
}

function collectorCustomerScope(collector, alias = 'c') {
  const area = String(collector.area || '').trim();
  if (area) {
    return {
      sql: `(${alias}.collector_id = ? OR ((${alias}.collector_id IS NULL OR ${alias}.collector_id = 0) AND LOWER(TRIM(${alias}.area)) = LOWER(TRIM(?))))`,
      params: [collector.id, area]
    };
  }
  return {
    sql: `(${alias}.collector_id = ? OR ${alias}.collector_id IS NULL)`,
    params: [collector.id]
  };
}

function collectorCanAccessCustomer(collector, customerId) {
  if (!collector) return false;
  const scope = collectorCustomerScope(collector);
  return Boolean(db.prepare(`SELECT c.id FROM customers c WHERE c.id = ? AND ${scope.sql}`).get(toInt(customerId), ...scope.params));
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
  kolektor: 'collectors',
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

    if (role === 'kolektor') {
      const collector = getActiveCollector(userId);
      if (!collector) return res.status(404).json(errorResponse('NOT_FOUND', 'Kolektor tidak ditemukan.'));
      const scope = collectorCustomerScope(collector);
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const summary = db.prepare(`
        SELECT COUNT(DISTINCT c.id) AS assignedCustomers,
               SUM(CASE WHEN i.status = 'unpaid' OR i.status IS NULL THEN 1 ELSE 0 END) AS unpaidCount,
               SUM(CASE WHEN i.status = 'unpaid' OR i.status IS NULL THEN COALESCE(i.amount, p.price, 0) ELSE 0 END) AS unpaidTotal,
               SUM(CASE WHEN i.status = 'paid' THEN COALESCE(i.amount, 0) ELSE 0 END) AS collectedThisMonth
        FROM customers c
        LEFT JOIN packages p ON c.package_id = p.id
        LEFT JOIN invoices i ON i.customer_id = c.id AND i.period_month = ? AND i.period_year = ?
        WHERE ${scope.sql}
      `).get(month, year, ...scope.params) || {};
      const recentCollections = db.prepare(`
        SELECT i.*, c.name AS customer_name, p.name AS package_name
        FROM collector_payment_requests r
        JOIN invoices i ON i.id = r.invoice_id
        JOIN customers c ON c.id = i.customer_id
        LEFT JOIN packages p ON p.id = c.package_id
        WHERE r.collector_id = ? AND r.status = 'approved'
        ORDER BY COALESCE(r.decided_at, i.paid_at, r.created_at) DESC
        LIMIT 5
      `).all(collector.id).map(projectInvoice);
      return res.status(200).json(successResponse({
        role,
        area: collector.area || null,
        ...summary,
        recentCollections
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

const MOBILE_ATTENDANCE_ROLES = ['teknisi', 'customer_service'];

router.get('/attendance', requireMobileRole(MOBILE_ATTENDANCE_ROLES), requireMobileAttendanceMenu, (req, res) => {
  try {
    const identity = mobileAttendanceIdentity(req);
    if (!identity) return res.status(404).json(errorResponse('NOT_FOUND', 'Akun karyawan tidak ditemukan.'));
    const { employeeType, employee } = identity;
    const now = getCurrentDateInTimezone();
    const today = attendanceSvc.getTodayAttendance(employeeType, employee.id);
    const history = attendanceSvc.getAttendanceHistory(employeeType, employee.id, 10);
    const summary = attendanceSvc.getMonthlyAttendanceSummary(employeeType, employee.id, now.getFullYear(), now.getMonth() + 1) || {};
    const geofencing = attendanceSvc.getGeofencingSettings();
    return res.status(200).json(successResponse({
      employee: { id: employee.id, name: employee.name || employee.username },
      employeeType,
      todayAttendance: projectAttendance(today),
      history: history.map(projectAttendance),
      summary: {
        totalDays: Number(summary.total_days || 0),
        completedDays: Number(summary.completed_days || 0),
        totalMinutes: Number(summary.total_minutes || 0),
        averageMinutes: Number(summary.avg_minutes || 0)
      },
      geofencing: { enabled: Boolean(geofencing.enabled), radius: Number(geofencing.radius || 0) }
    }));
  } catch (err) {
    logger.error(`[mobile-api] attendance read error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Riwayat absensi gagal dimuat.'));
  }
});

router.post('/attendance/check-in', requireMobileRole(MOBILE_ATTENDANCE_ROLES), requireMobileAttendanceMenu, mobileAttendanceUpload, (req, res) => {
  if (!req.file) return res.status(422).json(errorResponse('PHOTO_REQUIRED', 'Foto check-in wajib diunggah.'));
  try {
    const identity = mobileAttendanceIdentity(req);
    if (!identity) {
      removeAttendanceFile(req.file);
      return res.status(404).json(errorResponse('NOT_FOUND', 'Akun karyawan tidak ditemukan.'));
    }
    const { employeeType, employee } = identity;
    const today = attendanceSvc.getTodayAttendance(employeeType, employee.id);
    if (today) {
      removeAttendanceFile(req.file);
      return res.status(409).json(errorResponse('ALREADY_CHECKED_IN', 'Anda sudah melakukan check-in hari ini.'));
    }
    const { lat, lng } = readAttendanceCoordinates(req.body || {});
    const result = attendanceSvc.checkIn({
      employee_type: employeeType,
      employee_id: employee.id,
      employee_name: employee.name || employee.username,
      lat,
      lng,
      note: String((req.body || {}).note || '').trim().slice(0, 500),
      photo: `/uploads/attendance/${req.file.filename}`
    });
    const record = attendanceSvc.getTodayAttendance(employeeType, employee.id);
    return res.status(201).json(successResponse({
      attendance: projectAttendance(record),
      id: Number(result.lastInsertRowid)
    }));
  } catch (err) {
    removeAttendanceFile(req.file);
    const message = String(err.message || 'Check-in gagal.');
    const isLocationError = /location|gps|range|far|jarak|lokasi/i.test(message);
    return res.status(isLocationError ? 422 : 500).json(errorResponse(isLocationError ? 'LOCATION_REJECTED' : 'INTERNAL_ERROR', message));
  }
});

router.post('/attendance/check-out', requireMobileRole(MOBILE_ATTENDANCE_ROLES), requireMobileAttendanceMenu, mobileAttendanceUpload, (req, res) => {
  if (!req.file) return res.status(422).json(errorResponse('PHOTO_REQUIRED', 'Foto check-out wajib diunggah.'));
  try {
    const identity = mobileAttendanceIdentity(req);
    if (!identity) {
      removeAttendanceFile(req.file);
      return res.status(404).json(errorResponse('NOT_FOUND', 'Akun karyawan tidak ditemukan.'));
    }
    const { employeeType, employee } = identity;
    const today = attendanceSvc.getTodayAttendance(employeeType, employee.id);
    if (!today) {
      removeAttendanceFile(req.file);
      return res.status(409).json(errorResponse('NOT_CHECKED_IN', 'Anda belum check-in hari ini.'));
    }
    if (today.status === 'checked_out') {
      removeAttendanceFile(req.file);
      return res.status(409).json(errorResponse('ALREADY_CHECKED_OUT', 'Anda sudah check-out hari ini.'));
    }
    const { lat, lng } = readAttendanceCoordinates(req.body || {});
    attendanceSvc.checkOut(today.id, {
      lat,
      lng,
      note: String((req.body || {}).note || '').trim().slice(0, 500),
      photo: `/uploads/attendance/${req.file.filename}`
    });
    const record = attendanceSvc.getTodayAttendance(employeeType, employee.id);
    return res.status(200).json(successResponse({ attendance: projectAttendance(record) }));
  } catch (err) {
    removeAttendanceFile(req.file);
    const message = String(err.message || 'Check-out gagal.');
    const isLocationError = /location|gps|range|far|jarak|lokasi/i.test(message);
    return res.status(isLocationError ? 422 : 500).json(errorResponse(isLocationError ? 'LOCATION_REJECTED' : 'INTERNAL_ERROR', message));
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

router.post('/customers/:id/profile', requireMobileRole(STAFF_ROLES), (req, res) => {
  const id = toInt(req.params.id, 0);
  if (id <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'ID pelanggan tidak valid.'));
  const current = customerSvc.getCustomerById(id);
  if (!current) return res.status(404).json(errorResponse('NOT_FOUND', 'Pelanggan tidak ditemukan.'));

  const body = req.body || {};
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const address = String(body.address || '').trim();
  const area = String(body.area || '').trim();
  if (!name || name.length > 120) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Nama wajib diisi (maksimal 120 karakter).'));
  if (phone.length > 32 || address.length > 500 || area.length > 120) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Panjang telepon, alamat, atau area melebihi batas.'));
  }
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Format email tidak valid.'));
  }
  if (email && db.prepare("SELECT id FROM customers WHERE LOWER(email)=? AND email != '' AND id != ? LIMIT 1").get(email, id)) {
    return res.status(409).json(errorResponse('EMAIL_IN_USE', 'Email ini sudah terdaftar pada pelanggan lain.'));
  }

  try {
    customerSvc.updateCustomer(id, { ...current, name, phone, email, address, area });
    const updated = customerSvc.getCustomerById(id);
    auditSvc.logAuditTrail({
      action: 'UPDATE_CUSTOMER_PROFILE_MOBILE',
      entity_type: 'customer',
      entity_id: String(id),
      ...actorFromReq(req),
      details: { fields: ['name', 'phone', 'email', 'address', 'area'] }
    });
    return res.status(200).json(successResponse({ customer: projectCustomerForStaff(updated) }));
  } catch (err) {
    logger.error(`[mobile-api] customer profile update error id=${id}: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Profil pelanggan gagal diperbarui.'));
  }
});

router.post('/customers/:id/service', requireMobileRole(STAFF_ROLES), async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (id <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'ID pelanggan tidak valid.'));
  const current = customerSvc.getCustomerById(id);
  if (!current) return res.status(404).json(errorResponse('NOT_FOUND', 'Pelanggan tidak ditemukan.'));
  const action = String((req.body || {}).action || '').trim();
  try {
    if (action === 'isolate') {
      if (current.status === 'suspended') return res.status(409).json(errorResponse('CONFLICT', 'Pelanggan sudah diisolir.'));
      await customerSvc.suspendCustomer(id);
    } else if (action === 'unisolate') {
      if (current.status === 'active') return res.status(409).json(errorResponse('CONFLICT', 'Pelanggan sudah aktif.'));
      await customerSvc.activateCustomer(id);
    } else if (action === 'setPackage') {
      const packageId = toInt((req.body || {}).packageId, 0);
      const pkg = customerSvc.getPackageById(packageId);
      if (!pkg) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Paket tidak ditemukan.'));
      const previousPackageId = current.package_id;
      customerSvc.updateCustomer(id, { ...current, package_id: packageId });
      const updated = customerSvc.getCustomerById(id);
      try {
        const effectiveRouterId = customerSvc.getEffectiveRouterId(updated.router_id || current.router_id);
        if (effectiveRouterId) {
          const targetProfile = updated.status === 'suspended' ? (updated.isolir_profile || 'isolir') : pkg.name;
          if (updated.connection_type === 'pppoe' && updated.pppoe_username && targetProfile) {
            await mikrotikService.setPppoeProfile(updated.pppoe_username, targetProfile, effectiveRouterId);
            logger.info(`[mobile-api] Updated PPPoE profile for ${updated.pppoe_username} to ${targetProfile}`);
          }
          if (updated.connection_type === 'hotspot' && updated.hotspot_username) {
            await mikrotikService.upsertHotspotUser({
              username: updated.hotspot_username,
              password: updated.hotspot_password || '',
              profile: targetProfile,
              macAddress: updated.mac_address || '',
              disabled: updated.status !== 'active'
            }, effectiveRouterId);
          }
        }
      } catch (syncErr) {
        logger.warn(`[mobile-api] MikroTik sync skipped/failed after package change id=${id}: ${syncErr.message}`);
      }
      auditSvc.logAuditTrail({
        action: 'CHANGE_CUSTOMER_PACKAGE_MOBILE',
        entity_type: 'customer',
        entity_id: String(id),
        ...actorFromReq(req),
        details: { from: previousPackageId, to: packageId }
      });
    } else {
      return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Aksi layanan tidak valid.'));
    }
    const updated = customerSvc.getCustomerById(id);
    if (action === 'isolate' || action === 'unisolate') {
      auditSvc.logAuditTrail({
        action: action === 'isolate' ? 'ISOLATE_CUSTOMER_MOBILE' : 'UNISOLATE_CUSTOMER_MOBILE',
        entity_type: 'customer',
        entity_id: String(id),
        ...actorFromReq(req)
      });
    }
    return res.status(200).json(successResponse({ customer: projectCustomerForStaff(updated) }));
  } catch (err) {
    logger.error(`[mobile-api] customer service action ${action} error id=${id}: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Aksi layanan gagal diproses.'));
  }
});

router.get('/admin/registrations', requireMobileRole('admin'), (req, res) => {
  try {
    const status = String(req.query.status || 'surveyed').trim();
    const allowedStatuses = new Set(['pending_survey', 'surveyed', 'approved', 'rejected']);
    if (!allowedStatuses.has(status)) return res.status(400).json(errorResponse('VALIDATION_ERROR', 'Status pendaftaran tidak valid.'));
    const items = customerSvc.getOnlineRegistrations(status).map((registration) => ({
      id: registration.id,
      name: registration.name,
      phone: registration.phone || null,
      email: registration.email || null,
      address: registration.address || null,
      area: registration.area || null,
      lat: registration.lat || null,
      lng: registration.lng || null,
      createdAt: registration.created_at || null,
      registrationStatus: registration.registration_status || null,
      registrationNumber: registration.registration_number || null,
      surveyStatus: registration.survey_status || null,
      surveyNotes: registration.survey_notes || null,
      surveyedAt: registration.surveyed_at || null,
      surveyedByTechName: registration.surveyed_by_tech_name || null,
      approvedBy: registration.registration_approved_by || null,
      approvedAt: registration.registration_approved_at || null,
      rejectedBy: registration.registration_rejected_by || null,
      rejectedAt: registration.registration_rejected_at || null,
      rejectReason: registration.registration_reject_reason || null,
      packageName: registration.package_name || null
    }));
    return res.status(200).json(successResponse({ items }));
  } catch (err) {
    logger.error(`[mobile-api] registrations error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Pendaftaran gagal dimuat.'));
  }
});

router.post('/admin/registrations/:id/approve', requireMobileRole('admin'), async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (id <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'ID pendaftar tidak valid.'));
  try {
    const approver = String(actorFromReq(req).name || 'Admin (Mobile)');
    const registration = customerSvc.approveOnlineRegistration(id, approver);
    await customerSvc.activateCustomer(id);
    auditSvc.logAuditTrail({
      action: 'APPROVE_ONLINE_REGISTRATION_MOBILE',
      entity_type: 'customer',
      entity_id: String(id),
      ...actorFromReq(req)
    });
    return res.status(200).json(successResponse({ registration: { id: registration.id, registrationStatus: registration.registration_status } }));
  } catch (err) {
    logger.warn(`[mobile-api] approve registration failed id=${id}: ${err.message}`);
    return res.status(409).json(errorResponse('CONFLICT', String(err.message || 'Pendaftaran gagal disetujui.')));
  }
});

router.post('/admin/registrations/:id/reject', requireMobileRole('admin'), (req, res) => {
  const id = toInt(req.params.id, 0);
  if (id <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'ID pendaftar tidak valid.'));
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Alasan penolakan wajib diisi.'));
  if (reason.length > 1000) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Alasan penolakan terlalu panjang.'));
  try {
    const rejector = String(actorFromReq(req).name || 'Admin (Mobile)');
    const registration = customerSvc.rejectOnlineRegistration(id, rejector, reason);
    auditSvc.logAuditTrail({
      action: 'REJECT_ONLINE_REGISTRATION_MOBILE',
      entity_type: 'customer',
      entity_id: String(id),
      ...actorFromReq(req),
      details: { reject_reason: reason }
    });
    return res.status(200).json(successResponse({ registration: { id: registration.id, registrationStatus: registration.registration_status } }));
  } catch (err) {
    logger.warn(`[mobile-api] reject registration failed id=${id}: ${err.message}`);
    return res.status(409).json(errorResponse('CONFLICT', String(err.message || 'Pendaftaran gagal ditolak.')));
  }
});

/** GET /invoices */
router.get('/admin/accounts', requireMobileRole('admin'), (req, res) => {
  try {
    const roleFilter = String(req.query.role || '').trim();
    const collect = (rows, accountRole, extra) => rows.map((r) => ({
      id: r.id,
      role: accountRole,
      username: r.username,
      name: r.name,
      phone: r.phone || null,
      area: r.area || null,
      isActive: Number(r.is_active ?? 1) === 1,
      ...(extra ? extra(r) : {})
    }));
    if (roleFilter && ['technician', 'cashier', 'collector', 'agent'].includes(roleFilter)) {
      const rows = roleFilter === 'technician' ? adminSvc.getAllTechnicians()
        : roleFilter === 'cashier' ? adminSvc.getAllCashiers()
        : roleFilter === 'collector' ? adminSvc.getAllCollectors()
        : agentSvc.getAllAgents();
      const extra = roleFilter === 'collector' ? (r) => ({ autoApprove: Number(r.auto_approve ?? 0) === 1 })
        : roleFilter === 'agent' ? (r) => ({ balance: Number(r.balance || 0), billingFee: Number(r.billing_fee || 0) })
        : null;
      return res.status(200).json(successResponse({ items: collect(rows, roleFilter, extra) }));
    }
    const items = [
      ...collect(adminSvc.getAllTechnicians(), 'technician', null),
      ...collect(adminSvc.getAllCashiers(), 'cashier', null),
      ...collect(adminSvc.getAllCollectors(), 'collector', (r) => ({ autoApprove: Number(r.auto_approve ?? 0) === 1 })),
      ...collect(agentSvc.getAllAgents(), 'agent', (r) => ({ balance: Number(r.balance || 0), billingFee: Number(r.billing_fee || 0) })),
    ].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return res.status(200).json(successResponse({ items }));
  } catch (err) {
    logger.error(`[mobile-api] accounts list error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Daftar akun gagal dimuat.'));
  }
});

router.post('/admin/accounts', requireMobileRole('admin'), (req, res) => {
  const role = String((req.body || {}).role || '').trim();
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  const name = String((req.body || {}).name || '').trim();
  const phone = String((req.body || {}).phone || '').trim();
  const area = String((req.body || {}).area || '').trim();
  if (!role || !['technician', 'cashier', 'collector', 'agent'].includes(role)) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Role akun tidak valid.'));
  }
  if (!username || !name || !password || password.length < 6) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Username, nama, dan password (minimal 6 karakter) wajib diisi.'));
  }
  try {
    const input = { username, password, name, phone };
    let result;
    if (role === 'technician') result = adminSvc.createTechnician(input);
    else if (role === 'cashier') result = adminSvc.createCashier(input);
    else if (role === 'collector') result = adminSvc.createCollector({ ...input, area, auto_approve: Number((req.body || {}).autoApprove ?? 0) === 1 ? 1 : 0 });
    else result = agentSvc.createAgent({ ...input, balance: Number((req.body || {}).balance || 0), billing_fee: Number((req.body || {}).billingFee || 0) });
    auditSvc.logAuditTrail({
      action: 'CREATE_ACCOUNT_MOBILE',
      entity_type: role,
      entity_id: String(result.lastInsertRowid || result.insertId),
      ...actorFromReq(req)
    });
    return res.status(201).json(successResponse({ id: result.lastInsertRowid || result.insertId }));
  } catch (err) {
    logger.warn(`[mobile-api] account create failed: ${err.message}`);
    return res.status(409).json(errorResponse('CONFLICT', String(err.message || 'Akun gagal dibuat.')));
  }
});

router.post('/admin/accounts/:id/update', requireMobileRole('admin'), (req, res) => {
  const id = toInt(req.params.id, 0);
  const role = String((req.body || {}).role || '').trim();
  if (id <= 0 || !role || !['technician', 'cashier', 'collector', 'agent'].includes(role)) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Role atau ID akun tidak valid.'));
  }
  const body = req.body || {};
  const data = {
    username: String(body.username || '').trim() || undefined,
    name: String(body.name || '').trim() || undefined,
    phone: String(body.phone || '').trim() || '',
    area: String(body.area || '').trim() || '',
    is_active: body.isActive !== undefined ? (body.isActive ? '1' : '0') : undefined,
  };
  if (body.password && String(body.password).length >= 6) data.password = String(body.password);
  try {
    if (role === 'technician') adminSvc.updateTechnician(id, data);
    else if (role === 'cashier') adminSvc.updateCashier(id, data);
    else if (role === 'collector') adminSvc.updateCollector(id, data);
    else agentSvc.updateAgent(id, { ...data, balance: Number(body.balance || 0), billing_fee: Number(body.billingFee || 0) });
    auditSvc.logAuditTrail({
      action: 'UPDATE_ACCOUNT_MOBILE',
      entity_type: role,
      entity_id: String(id),
      ...actorFromReq(req)
    });
    return res.status(200).json(successResponse({ id }));
  } catch (err) {
    logger.warn(`[mobile-api] account update failed id=${id}: ${err.message}`);
    return res.status(409).json(errorResponse('CONFLICT', String(err.message || 'Akun gagal diperbarui.')));
  }
});

router.post('/admin/accounts/:id/topup', requireMobileRole('admin'), (req, res) => {
  const id = toInt(req.params.id, 0);
  const amount = Number((req.body || {}).amount || 0);
  const note = String((req.body || {}).note || '').trim();
  if (id <= 0 || !Number.isFinite(amount) || amount <= 0) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Nominal topup tidak valid.'));
  }
  try {
    const agent = agentSvc.getAgentById(id);
    if (!agent) return res.status(404).json(errorResponse('NOT_FOUND', 'Reseller tidak ditemukan.'));
    const actorName = String(actorFromReq(req).name || 'Admin (Mobile)');
    agentSvc.topupAgent(id, amount, note, actorName);
    auditSvc.logAuditTrail({
      action: 'TOPUP_AGENT_MOBILE',
      entity_type: 'agent',
      entity_id: String(id),
      ...actorFromReq(req),
      details: { amount, note }
    });
    return res.status(200).json(successResponse({ id, balance: Number(agentSvc.getAgentById(id).balance || 0) }));
  } catch (err) {
    logger.warn(`[mobile-api] agent topup failed id=${id}: ${err.message}`);
    return res.status(409).json(errorResponse('CONFLICT', String(err.message || 'Topup saldo gagal.')));
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
    if (role === 'kolektor') {
      const collector = getActiveCollector(userId);
      if (!collector) return res.status(404).json(errorResponse('NOT_FOUND', 'Kolektor tidak ditemukan.'));
      const scope = collectorCustomerScope(collector);
      const conditions = [scope.sql];
      const params = [...scope.params];
      const status = String(req.query.status || '').trim();
      const search = String(req.query.q || '').trim().slice(0, 100);
      if (status === 'paid' || status === 'unpaid') {
        conditions.push('i.status = ?');
        params.push(status);
      }
      if (search) {
        conditions.push('(c.name LIKE ? OR c.phone LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      const rows = db.prepare(`
        SELECT i.*, c.name AS customer_name, p.name AS package_name
        FROM invoices i
        JOIN customers c ON c.id = i.customer_id
        LEFT JOIN packages p ON p.id = c.package_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.period_year DESC, i.period_month DESC, c.name ASC
        LIMIT ?
      `).all(...params, clampLimit(req.query.limit, 100, 300));
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
    if (role === 'kolektor') {
      const collector = getActiveCollector(req.mobileUser.userId);
      if (!collectorCanAccessCustomer(collector, inv.customer_id)) {
        return res.status(404).json(errorResponse('NOT_FOUND', 'Tagihan tidak ditemukan.'));
      }
    }
    if (!STAFF_ROLES.includes(role) && role !== 'pelanggan' && role !== 'kolektor') {
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

router.post('/collector/payment-request', requireMobileRole('kolektor'), async (req, res) => {
  const invoiceId = toInt((req.body || {}).invoiceId, 0);
  const note = String((req.body || {}).note || '').trim().slice(0, 500);
  if (invoiceId <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Invoice tidak valid.'));

  try {
    const collector = getActiveCollector(req.mobileUser.userId);
    if (!collector) return res.status(404).json(errorResponse('NOT_FOUND', 'Kolektor tidak ditemukan.'));
    const inv = billingSvc.getInvoiceById(invoiceId);
    if (!inv || !collectorCanAccessCustomer(collector, inv.customer_id)) {
      return res.status(404).json(errorResponse('NOT_FOUND', 'Tagihan tidak ditemukan.'));
    }
    if (String(inv.status || '').toLowerCase() === 'paid') {
      return res.status(409).json(errorResponse('ALREADY_PAID', 'Tagihan sudah lunas.'));
    }
    const existingPending = db.prepare(`
      SELECT id FROM collector_payment_requests
      WHERE invoice_id = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 1
    `).get(invoiceId);
    if (existingPending) {
      return res.status(409).json(errorResponse('REQUEST_PENDING', 'Tagihan ini sedang menunggu approval.'));
    }
    const amount = Math.max(0, Number(inv.amount || 0));
    if (amount <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'Nominal tagihan tidak valid.'));

    if (Number(collector.auto_approve) === 1) {
      const collectorLabel = `Kolektor ${String(collector.name || '').trim()}${collector.username ? ` (@${collector.username})` : ''}`;
      const notes = ['Via Kolektor', collectorLabel, 'Auto-Approved (Kolektor Setting Aktif)', note]
        .filter(Boolean)
        .join(' | ');
      billingSvc.markAsPaid(inv.id, collectorLabel, notes, actorFromReq(req));
      db.prepare(`
        INSERT INTO collector_payment_requests
          (collector_id, invoice_id, customer_id, amount, note, status, decided_by_role, decided_by_name, decided_note, decided_at)
        VALUES (?, ?, ?, ?, ?, 'approved', 'system', 'Auto-Approve', 'Otomatis disetujui (kolektor setting aktif)', CURRENT_TIMESTAMP)
      `).run(collector.id, inv.id, Number(inv.customer_id || 0), amount, note);

      const customer = customerSvc.getCustomerById(inv.customer_id);
      if (customer && customer.status === 'suspended') {
        try {
          await customerSvc.activateCustomer(customer.id);
        } catch (activateError) {
          logger.error(`[mobile-collector] Failed to activate customer ${customer.id}:`, activateError);
        }
      }

      const updated = billingSvc.getInvoiceById(inv.id);
      return res.status(200).json(successResponse({
        status: 'approved',
        invoice: projectInvoice(updated),
        message: 'Pembayaran berhasil diproses dan tagihan sudah lunas.'
      }));
    }

    db.prepare(`
      INSERT INTO collector_payment_requests (collector_id, invoice_id, customer_id, amount, note, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(collector.id, inv.id, Number(inv.customer_id || 0), amount, note);
    return res.status(201).json(successResponse({
      status: 'pending',
      invoice: projectInvoice(inv),
      message: 'Pengajuan pembayaran menunggu approval Admin/Kasir.'
    }));
  } catch (err) {
    logger.error(`[mobile-collector] payment request error: ${err.message}`);
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

function projectAdminPackage(pkg) {
  return {
    id: pkg.id,
    name: pkg.name,
    price: Number(pkg.price || 0),
    speedDown: Number(pkg.speed_down || 0) / 1000,
    speedUp: Number(pkg.speed_up || 0) / 1000,
    billingType: pkg.billing_type || 'postpaid',
    durationDays: Number(pkg.duration_days || 30),
    description: pkg.description || '',
    isActive: Number(pkg.is_active ?? 1) === 1,
    customerCount: Number(pkg.customer_count || 0)
  };
}

function parseAdminPackageInput(body, isUpdate = false) {
  const name = String(body.name || '').trim();
  const price = Number(body.price);
  const speedDown = Number(body.speedDown);
  const speedUp = Number(body.speedUp);
  const durationDays = Number(body.durationDays || 30);
  if (!name || name.length > 100) throw new Error('Nama paket wajib diisi (maksimal 100 karakter).');
  if (!Number.isFinite(price) || price < 0) throw new Error('Harga paket tidak valid.');
  if (!Number.isFinite(speedDown) || speedDown < 0 || !Number.isFinite(speedUp) || speedUp < 0) {
    throw new Error('Kecepatan paket tidak valid.');
  }
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
    throw new Error('Durasi paket harus antara 1 dan 3650 hari.');
  }
  const billingType = String(body.billingType || 'postpaid');
  if (!['prepaid', 'postpaid'].includes(billingType)) throw new Error('Tipe billing tidak valid.');
  const input = {
    name,
    price,
    speed_down: speedDown,
    speed_up: speedUp,
    billing_type: billingType,
    duration_days: durationDays,
    description: String(body.description || '').trim().slice(0, 500)
  };
  if (isUpdate) input.is_active = body.isActive === false || String(body.isActive) === '0' ? '0' : '1';
  return input;
}

router.get('/admin/packages', requireMobileRole('admin'), (req, res) => {
  try {
    const items = customerSvc.getAllPackages().map(projectAdminPackage);
    return res.status(200).json(successResponse({ items }));
  } catch (err) {
    logger.error(`[mobile-api] admin packages error: ${err.message}`);
    return res.status(500).json(errorResponse('INTERNAL_ERROR', 'Kesalahan server.'));
  }
});

router.post('/admin/packages', requireMobileRole('admin'), (req, res) => {
  try {
    const input = parseAdminPackageInput(req.body || {});
    const result = customerSvc.createPackage(input);
    const pkg = customerSvc.getPackageById(result.lastInsertRowid);
    return res.status(201).json(successResponse({ package: projectAdminPackage(pkg) }));
  } catch (err) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', String(err.message || 'Paket tidak dapat dibuat.')));
  }
});

router.post('/admin/packages/:id/update', requireMobileRole('admin'), (req, res) => {
  const id = toInt(req.params.id, 0);
  if (id <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'ID paket tidak valid.'));
  try {
    if (!customerSvc.getPackageById(id)) return res.status(404).json(errorResponse('NOT_FOUND', 'Paket tidak ditemukan.'));
    customerSvc.updatePackage(id, parseAdminPackageInput(req.body || {}, true));
    return res.status(200).json(successResponse({ package: projectAdminPackage(customerSvc.getPackageById(id)) }));
  } catch (err) {
    return res.status(422).json(errorResponse('VALIDATION_ERROR', String(err.message || 'Paket tidak dapat diperbarui.')));
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

router.get('/reseller/voucher-prices', requireMobileRole('reseller'), (req, res) => {
  try {
    const items = agentSvc.getAgentPrices(toInt(req.mobileUser.userId))
      .filter(price => Number(price.is_active) === 1)
      .map(price => ({
        id: price.id,
        profileName: price.profile_name,
        routerName: price.router_name || null,
        validity: price.validity || null,
        buyPrice: Number(price.buy_price || 0),
        sellPrice: Number(price.sell_price || 0)
      }));
    return res.status(200).json(successResponse({ items }));
  } catch (err) {
    logger.error(`[mobile-api] reseller voucher prices error: ${err.message}`);
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

router.post('/reseller/sell-voucher', requireMobileRole('reseller'), async (req, res) => {
  try {
    const priceId = toInt((req.body || {}).priceId, 0);
    if (priceId <= 0) return res.status(422).json(errorResponse('VALIDATION_ERROR', 'priceId tidak valid.'));
    const result = await agentSvc.sellVoucherAsAgent(toInt(req.mobileUser.userId), priceId);
    return res.status(201).json(successResponse({
      receipt: result.receipt,
      balance: Number(result.agent.balance || 0),
      transactionId: Number(result.tx.id || 0)
    }));
  } catch (err) {
    logger.warn(`[mobile-api] reseller sell voucher failed: ${err.message}`);
    return res.status(409).json(errorResponse('CONFLICT', String(err.message || 'Penjualan voucher gagal.')));
  }
});

module.exports = router;
