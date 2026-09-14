// E2E check: admin sidebar menus + per-user permission enforcement across portals.
// Jalankan dari root repo saat aplikasi berjalan di localhost:3001: node scripts/dev/e2e-role-access.js
const path = require('path');
const db = require('../../config/database');
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'settings.json'), 'utf8'));
const sidebar = require('../../services/sidebarMenuService');
const userMgmt = require('../../services/userManagementService');
const permSvc = require('../../services/userPermissionService');

const BASE = 'http://localhost:3001';
function client() {
  const jar = {};
  return async (path, opts = {}) => {
    const headers = Object.assign({}, opts.headers || {}, { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });
    const r = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    return r;
  };
}
const form = (o) => new URLSearchParams(o).toString();
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const results = [];
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${info}`); };

const TEST_USERS = {
  technicians: { username: 'e2e_tek', password: 'test1234', name: 'E2E Teknisi', area: 'A' },
  cashiers: { username: 'e2e_kasir', password: 'test1234', name: 'E2E Kasir' },
  collectors: { username: 'e2e_kol', password: 'test1234', name: 'E2E Kolektor', area: 'A' },
  agents: { username: 'e2e_res', password: 'test1234', name: 'E2E Reseller' }
};

function cleanup() {
  for (const src of Object.keys(TEST_USERS)) {
    const row = db.prepare(`SELECT id FROM ${src} WHERE username=?`).get(TEST_USERS[src].username);
    if (row) { permSvc.clearUserPermissions(src, row.id); db.prepare(`DELETE FROM ${src} WHERE id=?`).run(row.id); }
  }
}

async function main() {
  cleanup();
  const admin = client();
  let r = await admin('/admin/login', { method: 'POST', headers: H, body: form({ username: settings.admin_username, password: settings.admin_password }) });
  ok('admin login', r.status === 302 && (r.headers.get('location') || '').startsWith('/admin'), r.headers.get('location'));

  // 1. All admin sidebar menus reachable
  const adminMenus = sidebar.MENU_DEFINITIONS.filter(m => m.roles.includes('admin'));
  for (const m of adminMenus) {
    const href = m.href.split('#')[0];
    const res = await admin(href);
    ok(`admin menu ${m.key} (${href})`, res.status === 200, `status=${res.status}${res.status >= 300 && res.status < 400 ? ' -> ' + res.headers.get('location') : ''}`);
  }

  // 2. Akses Role page renders with permission catalog
  r = await admin('/admin/users');
  const html = await r.text();
  ok('users page renders', r.status === 200 && html.includes('Akses Role'));
  ok('users page has permission checkboxes', html.includes('name="permissions"') && html.includes('use_custom_permissions'));
  ok('users page shows role labels', ['Admin', 'Kasir', 'Kolektor', 'Reseller', 'Teknisi'].every(l => html.includes(l)));
  ok('no "Agent" wording in users page', !/\bAgent\b/.test(html.replace(/user-agent/gi, '')));

  // 3. Create users via form with limited permissions
  const LIMITED = {
    technicians: ['tech_dashboard', 'tech_pool'],
    cashiers: ['dashboard', 'customers'],
    collectors: ['collector_dashboard'],
    agents: ['agent_home', 'agent_billing']
  };
  for (const src of Object.keys(TEST_USERS)) {
    const body = new URLSearchParams({ source: src, ...TEST_USERS[src], use_custom_permissions: '1' });
    LIMITED[src].forEach(k => body.append('permissions', k));
    r = await admin('/admin/users', { method: 'POST', headers: H, body: body.toString() });
    const row = db.prepare(`SELECT id FROM ${src} WHERE username=?`).get(TEST_USERS[src].username);
    const perms = row ? permSvc.getUserPermissions(src, row.id) : null;
    ok(`create ${src} with perms`, !!row && JSON.stringify(perms) === JSON.stringify(LIMITED[src]), JSON.stringify(perms));
  }

  // 4. Portal enforcement
  const kasir = client();
  r = await kasir('/admin/login', { method: 'POST', headers: H, body: form({ username: 'e2e_kasir', password: 'test1234' }) });
  ok('kasir login', r.status === 302);
  r = await kasir('/admin/customers'); ok('kasir allowed /admin/customers', r.status === 200, r.status);
  r = await kasir('/admin/billing'); ok('kasir blocked /admin/billing', r.status === 302 && r.headers.get('location') === '/admin', r.status);
  r = await kasir('/admin/reports'); ok('kasir blocked /admin/reports', r.status === 302, r.status);
  r = await kasir('/admin'); const kh = await r.text();
  ok('kasir sidebar hides billing', !kh.includes('href="/admin/billing"'));
  ok('kasir sidebar shows customers', kh.includes('href="/admin/customers"'));

  const tek = client();
  r = await tek('/tech/login', { method: 'POST', headers: H, body: form({ username: 'e2e_tek', password: 'test1234' }) });
  ok('teknisi login', r.status === 302, r.headers.get('location'));
  r = await tek('/tech/pool'); ok('teknisi allowed /tech/pool', r.status === 200, r.status);
  r = await tek('/tech/map'); ok('teknisi blocked /tech/map', r.status === 302, r.status);
  r = await tek('/tech/customers/new'); ok('teknisi blocked /tech/customers/new', r.status === 302, r.status);
  r = await tek('/tech'); const th = await r.text();
  ok('teknisi nav hides map', !th.includes('href="/tech/map"'));

  const kol = client();
  r = await kol('/collector/login', { method: 'POST', headers: H, body: form({ username: 'e2e_kol', password: 'test1234' }) });
  ok('kolektor login', r.status === 302, r.headers.get('location'));
  r = await kol('/collector'); ok('kolektor dashboard', r.status === 200, r.status);
  r = await kol('/collector/attendance'); ok('kolektor blocked /collector/attendance', r.status === 302, r.status);

  const res = client();
  r = await res('/agent/login', { method: 'POST', headers: H, body: form({ username: 'e2e_res', password: 'test1234' }) });
  ok('reseller login', r.status === 302, r.headers.get('location'));
  r = await res('/agent'); const ah = await r.text(); ok('reseller home', r.status === 200, r.status);
  ok('reseller nav hides voucher', !ah.includes('#section-voucher'));
  r = await res('/agent/sell-voucher', { method: 'POST', headers: H, body: form({}) });
  ok('reseller blocked sell-voucher', r.status === 302 || r.status === 403, r.status);

  // 5. Edit: switch to default (clear perms) -> access restored
  const kid = db.prepare("SELECT id FROM cashiers WHERE username='e2e_kasir'").get().id;
  r = await admin(`/admin/users/cashiers/${kid}/update`, { method: 'POST', headers: H, body: form({ name: 'E2E Kasir X', username: 'e2e_kasir', phone: '0812' }) });
  ok('update kasir (no custom perms)', r.status === 302 && permSvc.getUserPermissions('cashiers', kid) === null);
  r = await kasir('/admin/billing'); ok('kasir now allowed /admin/billing', r.status === 200, r.status);
  const pw = db.prepare('SELECT password FROM cashiers WHERE id=?').get(kid).password;
  ok('password kept after edit', pw.length > 20);

  // 6. Status toggle + reset password
  r = await admin(`/admin/users/cashiers/${kid}/status`, { method: 'POST', headers: H, body: form({ active: '0' }) });
  ok('deactivate kasir', db.prepare('SELECT is_active FROM cashiers WHERE id=?').get(kid).is_active === 0);
  const k2 = client();
  r = await k2('/admin/login', { method: 'POST', headers: H, body: form({ username: 'e2e_kasir', password: 'test1234' }) });
  ok('inactive kasir cannot login', r.status !== 302 || !(r.headers.get('location') || '').startsWith('/admin/'), r.status);
  r = await admin(`/admin/users/cashiers/${kid}/status`, { method: 'POST', headers: H, body: form({ active: '1' }) });
  r = await admin(`/admin/users/cashiers/${kid}/reset-password`, { method: 'POST', headers: H, body: form({ new_password: 'baru1234' }) });
  const k3 = client();
  r = await k3('/admin/login', { method: 'POST', headers: H, body: form({ username: 'e2e_kasir', password: 'baru1234' }) });
  ok('login with reset password', r.status === 302 && (r.headers.get('location') || '').startsWith('/admin'), r.headers.get('location'));

  // 7. Delete all
  for (const src of Object.keys(TEST_USERS)) {
    const row = db.prepare(`SELECT id FROM ${src} WHERE username=?`).get(TEST_USERS[src].username);
    r = await admin(`/admin/users/${src}/${row.id}/delete`, { method: 'POST', headers: H, body: '' });
    ok(`delete ${src}`, !db.prepare(`SELECT id FROM ${src} WHERE id=?`).get(row.id) && permSvc.getUserPermissions(src, row.id) === null);
  }

  cleanup();
  const fails = results.filter(x => !x.pass);
  console.log(`\nSUMMARY: ${results.length - fails.length}/${results.length} passed`);
  fails.forEach(f => console.log('  FAILED:', f.name, f.info));
  process.exit(fails.length ? 1 : 0);
}
main().catch(e => { console.error(e); cleanup(); process.exit(1); });
