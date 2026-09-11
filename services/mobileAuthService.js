/** services/mobileAuthService.js — Mobile API Authentication */

const crypto = require('crypto');
const db = require('../config/database');
const { getCanonicalRole } = require('../middleware/authz');
const { logger } = require('../config/logger');

const TOKEN_CONFIG = {
  access: 15 * 60,        
  refresh: 30 * 24 * 60 * 60  
};

/** Generate cryptographically random token (opaque, high entropy). */
function generateToken() {
  const buf = crypto.randomBytes(64);
  return buf.toString('base64url');
}

/** Create hash of token for server-side storage. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Get token fingerprint (first 16 chars) for quick lookups.
 */
function getTokenFingerprint(token) {
  return token.substring(0, 16);
}

/**
 * Validate token string format (safety check, not cryptographic).
 */
function isValidTokenFormat(token) {
  if (typeof token !== 'string') return false;
  
  return /^[A-Za-z0-9_-]{80,96}$/.test(token);
}

/** Create initial mobile session (login). */
function createSession(userId, role, deviceId = null, deviceInfo = null) {
  const now = Math.floor(Date.now() / 1000);
  
  const accessToken = generateToken();
  const refreshToken = generateToken();
  
  const accessTokenHash = hashToken(accessToken);
  const refreshTokenHash = hashToken(refreshToken);
  
  const accessFingerprint = getTokenFingerprint(accessToken);
  const refreshFingerprint = getTokenFingerprint(refreshToken);
  
  const accessExpiresAt = now + TOKEN_CONFIG.access;
  const refreshExpiresAt = now + TOKEN_CONFIG.refresh;
  
  try {
    
    const stmt = db.prepare(`
      INSERT INTO mobile_sessions (
        user_id, role, device_id, 
        access_token_hash, access_token_fingerprint,
        refresh_token_hash, refresh_token_fingerprint,
        access_expires_at, refresh_expires_at, 
        device_info, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    
    const deviceInfoJson = deviceInfo ? JSON.stringify(deviceInfo) : null;
    stmt.run(
      userId, role, deviceId || null,
      accessTokenHash, accessFingerprint,
      refreshTokenHash, refreshFingerprint,
      accessExpiresAt, refreshExpiresAt,
      deviceInfoJson
    );
    
    logger.info(`[mobile-auth] Session created: role=${role}, userId=${userId}, deviceId=${deviceId}`);
    
    return {
      accessToken,
      refreshToken,
      expiresIn: TOKEN_CONFIG.access,
      refreshExpiresIn: TOKEN_CONFIG.refresh
    };
  } catch (err) {
    logger.error(`[mobile-auth] Failed to create session: ${err.message}`);
    throw err;
  }
}

/** Validate access token (used in every API request). */
function validateAccessToken(token) {
  if (!isValidTokenFormat(token)) {
    return null;
  }
  
  try {
    const now = Math.floor(Date.now() / 1000);
    const tokenHash = hashToken(token);
    
    const stmt = db.prepare(`
      SELECT id, user_id, role, device_id
      FROM mobile_sessions
      WHERE access_token_hash = ?
        AND revoked_at IS NULL
        AND access_expires_at > ?
      LIMIT 1
    `);
    
    const row = stmt.get(tokenHash, now);
    if (!row) {
      return null;
    }
    
    return {
      sessionId: row.id,
      userId: row.user_id,
      role: row.role,
      deviceId: row.device_id
    };
  } catch (err) {
    logger.error(`[mobile-auth] Error validating access token: ${err.message}`);
    return null;
  }
}

/** Validate and refresh access token using refresh token. */
function refreshAccessToken(refreshToken) {
  if (!isValidTokenFormat(refreshToken)) {
    return null;
  }
  
  try {
    const now = Math.floor(Date.now() / 1000);
    const refreshTokenHash = hashToken(refreshToken);
    
    const stmt = db.prepare(`
      SELECT id, user_id, role, device_id, device_info
      FROM mobile_sessions
      WHERE refresh_token_hash = ?
        AND revoked_at IS NULL
        AND refresh_expires_at > ?
      LIMIT 1
    `);
    
    const session = stmt.get(refreshTokenHash, now);
    if (!session) {
      return null;
    }
    
    const newAccessToken = generateToken();
    const newAccessTokenHash = hashToken(newAccessToken);
    const newAccessFingerprint = getTokenFingerprint(newAccessToken);
    const newAccessExpiresAt = now + TOKEN_CONFIG.access;
    
    const updateStmt = db.prepare(`
      UPDATE mobile_sessions
      SET access_token_hash = ?,
          access_token_fingerprint = ?,
          access_expires_at = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    
    updateStmt.run(
      newAccessTokenHash,
      newAccessFingerprint,
      newAccessExpiresAt,
      session.id
    );
    
    logger.info(`[mobile-auth] Access token refreshed: sessionId=${session.id}`);
    
    return {
      accessToken: newAccessToken,
      expiresIn: TOKEN_CONFIG.access
    };
  } catch (err) {
    logger.error(`[mobile-auth] Error refreshing access token: ${err.message}`);
    return null;
  }
}

/** Revoke a single mobile session (logout from one device). */
function revokeSession(accessToken) {
  if (!isValidTokenFormat(accessToken)) {
    return false;
  }
  
  try {
    const tokenHash = hashToken(accessToken);
    const stmt = db.prepare(`
      UPDATE mobile_sessions
      SET revoked_at = datetime('now')
      WHERE access_token_hash = ? AND revoked_at IS NULL
    `);
    
    const result = stmt.run(tokenHash);
    if (result.changes > 0) {
      logger.info(`[mobile-auth] Session revoked`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(`[mobile-auth] Error revoking session: ${err.message}`);
    return false;
  }
}

/** Revoke all mobile sessions for a user (logout from all devices). */
function revokeAllUserSessions(userId) {
  try {
    const stmt = db.prepare(`
      UPDATE mobile_sessions
      SET revoked_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL
    `);
    
    const result = stmt.run(userId);
    logger.info(`[mobile-auth] Revoked ${result.changes} sessions for user ${userId}`);
    return result.changes;
  } catch (err) {
    logger.error(`[mobile-auth] Error revoking all user sessions: ${err.message}`);
    return 0;
  }
}

/** Get active session info (for debugging, not for auth checks). */
function getSessionInfo(sessionId) {
  try {
    const stmt = db.prepare(`
      SELECT id, user_id, role, device_id, device_info, 
             access_expires_at, refresh_expires_at, revoked_at, created_at
      FROM mobile_sessions
      WHERE id = ?
    `);
    
    return stmt.get(sessionId);
  } catch (err) {
    logger.error(`[mobile-auth] Error getting session info: ${err.message}`);
    return null;
  }
}

/** Cleanup expired sessions (periodic maintenance). */
function cleanupExpiredSessions() {
  try {
    const now = Math.floor(Date.now() / 1000);
    
    const stmt = db.prepare(`
      DELETE FROM mobile_sessions
      WHERE refresh_expires_at < ?
    `);
    
    const result = stmt.run(now);
    if (result.changes > 0) {
      logger.info(`[mobile-auth] Cleaned up ${result.changes} expired sessions`);
    }
    return result.changes;
  } catch (err) {
    logger.error(`[mobile-auth] Error cleaning up sessions: ${err.message}`);
    return 0;
  }
}

module.exports = {
  createSession,
  validateAccessToken,
  refreshAccessToken,
  revokeSession,
  revokeAllUserSessions,
  getSessionInfo,
  cleanupExpiredSessions,
  
  __testTokenConfig: TOKEN_CONFIG
};
