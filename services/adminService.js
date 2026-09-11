const db = require('../config/database');
const crypto = require('crypto');

/** Password Security Functions */

const HASH_ALGORITHM = 'sha256';
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;

/** Hash a plaintext password securely */
function hashPassword(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  const hash = crypto.pbkdf2Sync(plaintext, salt, ITERATIONS, KEY_LENGTH, HASH_ALGORITHM).toString('hex');
  
  return `${salt}$${ITERATIONS}$${hash}`;
}

/** Verify a plaintext password against a stored hash */
function verifyPassword(plaintext, storedHash) {
  if (!plaintext || !storedHash || typeof plaintext !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 3) {
      return false; 
    }
    
    const [salt, iterations, hash] = parts;
    const computedHash = crypto.pbkdf2Sync(plaintext, salt, parseInt(iterations), KEY_LENGTH, HASH_ALGORITHM).toString('hex');
    
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computedHash));
  } catch (e) {
    return false;
  }
}

/** Check if a password string is already a hash (not plaintext) */
function isPasswordHash(passwordStr) {
  if (!passwordStr || typeof passwordStr !== 'string') return false;
  
  const parts = passwordStr.split('$');
  if (parts.length !== 3) return false;
  
  const [salt, iterations, hash] = parts;
  
  if (!/^[a-f0-9]+$/i.test(salt)) return false;
  if (!/^\d+$/.test(iterations)) return false;
  if (!/^[a-f0-9]+$/i.test(hash)) return false;
  if (salt.length !== SALT_LENGTH * 2) return false; 
  if (hash.length !== KEY_LENGTH * 2) return false; 
  
  return true;
}

/**
 * TECHNICIANS
 */
function getAllTechnicians() {
  return db.prepare('SELECT * FROM technicians ORDER BY created_at DESC').all();
}

function createTechnician(data) {
  const stmt = db.prepare('INSERT INTO technicians (username, password, name, phone, area) VALUES (?, ?, ?, ?, ?)');
  return stmt.run(data.username, hashPassword(String(data.password || '')), data.name, data.phone || '', data.area || '');
}

function parseBoolInt(val, defaultVal = 0) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (val === true || val === 1 || val === '1' || val === 'true' || val === 'on' || val === 'yes') return 1;
  if (val === false || val === 0 || val === '0' || val === 'false' || val === 'off' || val === 'no') return 0;
  return Boolean(val) ? 1 : 0;
}

function updateTechnician(id, data) {
  const stmt = db.prepare('UPDATE technicians SET username = ?, password = ?, name = ?, phone = ?, area = ?, is_active = ? WHERE id = ?');
  return stmt.run(data.username, hashPassword(String(data.password || '')), data.name, data.phone || '', data.area || '', parseBoolInt(data.is_active, 1), id);
}

function deleteTechnician(id) {
  return db.prepare('DELETE FROM technicians WHERE id = ?').run(id);
}

function authenticateTechnician(username, password) {
  const tech = db.prepare('SELECT * FROM technicians WHERE username = ? AND is_active = 1').get(username);
  if (!tech) return null;

  if (isPasswordHash(tech.password)) {
    if (!verifyPassword(password, tech.password)) return null;
  } else {
    if (password !== tech.password) return null;
    try {
      const hashedPassword = hashPassword(password);
      db.prepare('UPDATE technicians SET password = ? WHERE id = ?').run(hashedPassword, tech.id);
    } catch (e) {
      console.error('[adminService] Failed to migrate technician password:', e.message);
    }
  }

  return tech;
}

/**
 * CASHIERS
 */
function getAllCashiers() {
  return db.prepare('SELECT * FROM cashiers ORDER BY created_at DESC').all();
}

function createCashier(data) {
  const stmt = db.prepare('INSERT INTO cashiers (username, password, name, phone) VALUES (?, ?, ?, ?)');
  const hashedPassword = hashPassword(data.password);
  return stmt.run(data.username, hashedPassword, data.name, data.phone || '');
}

function updateCashier(id, data) {
  const stmt = db.prepare('UPDATE cashiers SET username = ?, password = ?, name = ?, phone = ?, is_active = ? WHERE id = ?');
  const hashedPassword = hashPassword(data.password);
  return stmt.run(data.username, hashedPassword, data.name, data.phone || '', parseBoolInt(data.is_active, 1), id);
}

function deleteCashier(id) {
  return db.prepare('DELETE FROM cashiers WHERE id = ?').run(id);
}

function authenticateCashier(username, password) {
  const cashier = db.prepare('SELECT * FROM cashiers WHERE username = ? AND is_active = 1').get(username);
  if (!cashier) return null;
  
  if (isPasswordHash(cashier.password)) {
    
    if (!verifyPassword(password, cashier.password)) return null;
  } else {
    
    if (password !== cashier.password) return null;
    
    try {
      const hashedPassword = hashPassword(password);
      db.prepare('UPDATE cashiers SET password = ? WHERE id = ?').run(hashedPassword, cashier.id);
    } catch (e) {
      
      console.error('[adminService] Failed to migrate cashier password:', e.message);
    }
  }
  
  return cashier;
}

function getAllCollectors() {
  return db.prepare('SELECT * FROM collectors ORDER BY created_at DESC').all();
}

function createCollector(data) {
  return db
    .prepare(
      'INSERT INTO collectors (username, password, name, phone, area, is_active, auto_approve) VALUES (?, ?, ?, ?, ?, 1, ?)'
    )
    .run(
      String(data.username || '').trim(),
      hashPassword(String(data.password || '')),
      String(data.name || '').trim(),
      String(data.phone || '').trim(),
      String(data.area || '').trim(),
      parseBoolInt(data.auto_approve, 0)
    );
}

function updateCollector(id, data) {
  const stmt = db.prepare('UPDATE collectors SET username = ?, password = ?, name = ?, phone = ?, area = ?, is_active = ?, auto_approve = ? WHERE id = ?');
  return stmt.run(
    String(data.username || '').trim(),
    hashPassword(String(data.password || '')),
    String(data.name || '').trim(),
    String(data.phone || '').trim(),
    String(data.area || '').trim(),
    parseBoolInt(data.is_active, 1),
    parseBoolInt(data.auto_approve, 0),
    id
  );
}

function deleteCollector(id) {
  return db.prepare('DELETE FROM collectors WHERE id = ?').run(id);
}

function authenticateCollector(username, password) {
  const collector = db.prepare('SELECT * FROM collectors WHERE username = ? AND is_active = 1').get(username);
  if (!collector) return null;
  
  if (isPasswordHash(collector.password)) {
    
    if (!verifyPassword(password, collector.password)) return null;
  } else {
    
    if (password !== collector.password) return null;
    
    try {
      const hashedPassword = hashPassword(password);
      db.prepare('UPDATE collectors SET password = ? WHERE id = ?').run(hashedPassword, collector.id);
    } catch (e) {
      
      console.error('[adminService] Failed to migrate collector password:', e.message);
    }
  }
  
  return collector;
}

module.exports = {
  getAllTechnicians,
  createTechnician,
  updateTechnician,
  deleteTechnician,
  authenticateTechnician,
  getAllCashiers,
  createCashier,
  updateCashier,
  deleteCashier,
  authenticateCashier,
  getAllCollectors,
  createCollector,
  updateCollector,
  deleteCollector,
  authenticateCollector,
  hashPassword,
  verifyPassword,
  isPasswordHash
};
