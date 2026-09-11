const db = require('../config/database');
const { getSetting, getCurrentDateInTimezone, parseDateInTimezone } = require('../config/settingsManager');

/** ATTENDANCE SERVICE */

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c * 1000; 
  return distance;
}

function validateLocation(lat, lng) {
  
  const officeLat = parseFloat(getSetting('office_lat', '0'));
  const officeLng = parseFloat(getSetting('office_lng', '0'));
  const allowedRadius = parseInt(getSetting('attendance_radius', '100')); 
  const geofencingEnabled = getSetting('attendance_geofencing', 'true') === 'true';
  
  if (!geofencingEnabled || !officeLat || !officeLng) {
    return { valid: true, distance: 0, message: 'Geofencing disabled' };
  }
  
  if (!lat || !lng) {
    return { valid: false, distance: 0, message: 'GPS location required' };
  }
  
  const distance = calculateDistance(officeLat, officeLng, parseFloat(lat), parseFloat(lng));
  
  if (distance <= allowedRadius) {
    return {
      valid: true,
      distance: Math.round(distance),
      message: `Within range (${Math.round(distance)}m from office)`
    };
  } else {
    return {
      valid: false,
      distance: Math.round(distance),
      message: `Too far from office (${Math.round(distance)}m, max ${allowedRadius}m)`
    };
  }
}

function checkIn(data) {
  
  const locationCheck = validateLocation(data.lat, data.lng);
  if (!locationCheck.valid) {
    throw new Error(locationCheck.message);
  }
  const stmt = db.prepare(`
    INSERT INTO attendance (
      employee_type, employee_id, employee_name,
      check_in_time, check_in_lat, check_in_lng, check_in_note, check_in_photo
    ) VALUES (?, ?, ?, NOW_LOCAL(), ?, ?, ?, ?)
  `);
  
  return stmt.run(
    data.employee_type,
    data.employee_id,
    data.employee_name,
    data.lat || '',
    data.lng || '',
    data.note || '',
    data.photo || ''
  );
}

function checkOut(attendanceId, data) {
  const attendance = db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId);
  if (!attendance) {
    throw new Error('Attendance record not found');
  }
  
  if (attendance.status === 'checked_out') {
    throw new Error('Already checked out');
  }
  
  const locationCheck = validateLocation(data.lat, data.lng);
  if (!locationCheck.valid) {
    throw new Error(locationCheck.message);
  }
  
  const checkInTime = parseDateInTimezone(attendance.check_in_time);
  const checkOutTime = new Date();
  const durationMinutes = Math.floor((checkOutTime - checkInTime) / 1000 / 60);
  
  const stmt = db.prepare(`
    UPDATE attendance 
    SET check_out_time = NOW_LOCAL(),
        check_out_lat = ?,
        check_out_lng = ?,
        check_out_note = ?,
        check_out_photo = ?,
        work_duration_minutes = ?,
        status = 'checked_out'
    WHERE id = ?
  `);
  
  return stmt.run(
    data.lat || '',
    data.lng || '',
    data.note || '',
    data.photo || '',
    durationMinutes,
    attendanceId
  );
}

function getTodayAttendance(employeeType, employeeId) {
  const stmt = db.prepare(`
    SELECT * FROM attendance 
    WHERE employee_type = ? 
      AND employee_id = ? 
      AND date(check_in_time) = date(NOW_LOCAL())
    ORDER BY check_in_time DESC
    LIMIT 1
  `);
  
  return stmt.get(employeeType, employeeId);
}

function getAttendanceHistory(employeeType, employeeId, limit = 30) {
  const stmt = db.prepare(`
    SELECT * FROM attendance 
    WHERE employee_type = ? AND employee_id = ?
    ORDER BY check_in_time DESC
    LIMIT ?
  `);
  
  return stmt.all(employeeType, employeeId, limit);
}

function getAttendanceByDate(date) {
  const stmt = db.prepare(`
    SELECT * FROM attendance 
    WHERE date(check_in_time) = date(?)
    ORDER BY check_in_time DESC
  `);
  
  return stmt.all(date);
}

function getAttendanceByDateRange(startDate, endDate) {
  const stmt = db.prepare(`
    SELECT * FROM attendance 
    WHERE date(check_in_time) BETWEEN date(?) AND date(?)
    ORDER BY check_in_time DESC
  `);
  
  return stmt.all(startDate, endDate);
}

function getMonthlyAttendanceSummary(employeeType, employeeId, year, month) {
  const stmt = db.prepare(`
    SELECT 
      COUNT(*) as total_days,
      SUM(CASE WHEN status = 'checked_out' THEN 1 ELSE 0 END) as completed_days,
      SUM(work_duration_minutes) as total_minutes,
      AVG(work_duration_minutes) as avg_minutes
    FROM attendance 
    WHERE employee_type = ? 
      AND employee_id = ?
      AND strftime('%Y', check_in_time) = ?
      AND strftime('%m', check_in_time) = ?
  `);
  
  const yearStr = String(year);
  const monthStr = String(month).padStart(2, '0');
  
  return stmt.get(employeeType, employeeId, yearStr, monthStr);
}

function getTodayAllAttendance() {
  const stmt = db.prepare(`
    SELECT * FROM attendance 
    WHERE date(check_in_time) = date(NOW_LOCAL())
    ORDER BY check_in_time DESC
  `);
  
  return stmt.all();
}

function getAttendanceStats(date = null) {
  const dateFilter = date ? `date(check_in_time) = date('${date}')` : `date(check_in_time) = date(NOW_LOCAL())`;
  
  const stmt = db.prepare(`
    SELECT 
      employee_type,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'checked_in' THEN 1 ELSE 0 END) as checked_in,
      SUM(CASE WHEN status = 'checked_out' THEN 1 ELSE 0 END) as checked_out
    FROM attendance 
    WHERE ${dateFilter}
    GROUP BY employee_type
  `);
  
  return stmt.all();
}

function hasCheckedInToday(employeeType, employeeId) {
  const today = getTodayAttendance(employeeType, employeeId);
  return today !== undefined;
}

function getLateCheckIns(date = null) {
  const dateFilter = date ? `date(check_in_time) = date('${date}')` : `date(check_in_time) = date(NOW_LOCAL())`;
  
  const stmt = db.prepare(`
    SELECT * FROM attendance 
    WHERE ${dateFilter}
      AND time(check_in_time) > '08:30:00'
    ORDER BY check_in_time DESC
  `);
  
  return stmt.all();
}

function getNotCheckedOut(date = null) {
  const dateFilter = date ? `date(check_in_time) = date('${date}')` : `date(check_in_time) = date(NOW_LOCAL())`;
  
  const stmt = db.prepare(`
    SELECT * FROM attendance 
    WHERE ${dateFilter}
      AND status = 'checked_in'
    ORDER BY check_in_time DESC
  `);
  
  return stmt.all();
}

function deleteAttendance(id) {
  return db.prepare('DELETE FROM attendance WHERE id = ?').run(id);
}

function updateAttendance(id, data) {
  const stmt = db.prepare(`
    UPDATE attendance 
    SET check_in_time = ?,
        check_in_note = ?,
        check_out_time = ?,
        check_out_note = ?,
        work_duration_minutes = ?
    WHERE id = ?
  `);
  
  return stmt.run(
    data.check_in_time,
    data.check_in_note || '',
    data.check_out_time || null,
    data.check_out_note || '',
    data.work_duration_minutes || 0,
    id
  );
}

function getGeofencingSettings() {
  return {
    enabled: getSetting('attendance_geofencing', 'true') === 'true',
    officeLat: parseFloat(getSetting('office_lat', '0')),
    officeLng: parseFloat(getSetting('office_lng', '0')),
    radius: parseInt(getSetting('attendance_radius', '100'))
  };
}

module.exports = {
  checkIn,
  checkOut,
  getTodayAttendance,
  getAttendanceHistory,
  getAttendanceByDate,
  getAttendanceByDateRange,
  getMonthlyAttendanceSummary,
  getTodayAllAttendance,
  getAttendanceStats,
  hasCheckedInToday,
  getLateCheckIns,
  getNotCheckedOut,
  deleteAttendance,
  updateAttendance,
  validateLocation,
  calculateDistance,
  getGeofencingSettings
};

