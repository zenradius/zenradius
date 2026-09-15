/**
 * Smoke test Audit Trail: insert via logAuditTrail & log() compat, filter, stats, cleanup.
 * Jalankan: node scripts/test-audit-trail.js
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const audit = require('../services/auditTrailService');
const db = require('../config/database');

const TAG = '__audit_test__';
let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✅', msg);
  else { failed++; console.log('  ❌', msg); }
}

try {
  audit.logAuditTrail({
    action: 'CREATE', entity_type: TAG, entity_id: '1',
    actor_type: 'admin', actor_id: TAG, actor_name: 'Tester',
    details: { foo: 'bar' }, ip_address: '127.0.0.1', user_agent: 'test'
  });
  audit.log('admin', TAG, 'update', 'compat message', { entity_type: TAG, entity_id: '2' });

  const rows = audit.getAuditTrail({ entity_type: TAG, limit: 10 });
  assert(rows.length === 2, 'dua log tersimpan');

  const compat = rows.find(r => r.entity_id === '2');
  assert(compat && compat.action === 'UPDATE', 'log() compat: action di-uppercase');
  assert(compat && compat.details && compat.details.message === 'compat message', 'log() compat: details.message terparse');

  const created = rows.find(r => r.entity_id === '1');
  assert(created && created.details && created.details.foo === 'bar', 'details JSON terparse');

  assert(audit.getAuditTrail({ entity_type: TAG, action: 'CREATE' }).length === 1, 'filter action');
  assert(audit.getAuditTrail({ entity_type: TAG, actor_type: 'admin' }).length === 2, 'filter actor_type');
  assert(audit.getAuditTrail({ entity_type: TAG, actor_type: 'customer' }).length === 0, 'filter actor_type (kosong)');

  const stats = audit.getAuditStats();
  assert(typeof stats.total === 'number' && stats.total >= 2, 'stats.total tersedia');
  assert(Array.isArray(stats.by_action) && Array.isArray(stats.by_entity_type), 'stats.by_action / by_entity_type array');
} finally {
  db.prepare('DELETE FROM audit_trail WHERE entity_type = ?').run(TAG);
  console.log('  🧹 cleanup selesai');
}

console.log(failed ? `\n${failed} test gagal` : '\nSemua test Audit Trail lulus');
process.exit(failed ? 1 : 0);
