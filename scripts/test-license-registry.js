/**
 * Uji integrasi end-to-end registry lisensi v3 (butuh internet).
 * Pakai: MASTER_SECRET=... node scripts/test-license-registry.js
 * Alur: issue-token → verifikasi lokal (kunci publik) → heartbeat (active)
 *       → revoke → heartbeat (revoked) → unrevoke → hapus instalasi uji.
 */
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const API = process.env.ZENRADIUS_REGISTRY_API || 'https://api.license.zenradius.net';
const SECRET = process.env.MASTER_SECRET;
if (!SECRET) { console.error('Set MASTER_SECRET'); process.exit(1); }
const tokenSvc = require(path.join(__dirname, '..', 'services', 'licenseTokenService'));

const IC = 'TEST-' + Math.random().toString(16).slice(2, 6).toUpperCase() + '-' + Math.random().toString(16).slice(2, 6).toUpperCase();
const SUB = 'local';
let fails = 0;
const assert = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!cond) fails++; };

async function api(p, opts = {}, auth = true) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${SECRET}`;
  const r = await fetch(API + p, { ...opts, headers });
  const d = await r.json().catch(() => null);
  return { status: r.status, d };
}
const hb = (token) => api('/api/heartbeat', { method: 'POST', body: JSON.stringify({ domain: SUB, install_code: IC, instance_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', token, app_version: 'test' }) }, false);

(async () => {
  const iss = await api('/api/issue-token', { method: 'POST', body: JSON.stringify({ subject: SUB, install_code: IC, note: 'integration test' }) });
  assert('issue-token 200', iss.status === 200, JSON.stringify(iss.d).slice(0, 120));
  const token = iss.d && iss.d.token; const lid = iss.d && iss.d.license_id;

  const v = tokenSvc.verifyToken(token, { subject: SUB, installCode: IC });
  assert('verifikasi lokal token sah', v.valid, v.reason || '');
  assert('verifikasi lokal install lain gagal', !tokenSvc.verifyToken(token, { subject: SUB, installCode: 'XXXX-XXXX-XXXX' }).valid);

  let h = await hb(token);
  assert('heartbeat active', h.d && h.d.valid === true && h.d.license_status === 'active' && h.d.license_id === lid, JSON.stringify(h.d));

  const rv = await api('/api/revoke', { method: 'POST', body: JSON.stringify({ license_id: lid, reason: 'test' }) });
  assert('revoke', rv.status === 200 && rv.d.changed === 1);
  h = await hb(token);
  assert('heartbeat revoked', h.d && h.d.valid === false && h.d.license_status === 'revoked', JSON.stringify(h.d));

  const ur = await api('/api/unrevoke', { method: 'POST', body: JSON.stringify({ license_id: lid }) });
  assert('unrevoke', ur.status === 200 && ur.d.changed === 1);
  h = await hb(token);
  assert('heartbeat active lagi', h.d && h.d.valid === true);

  // re-issue → token lama superseded
  const iss2 = await api('/api/issue-token', { method: 'POST', body: JSON.stringify({ subject: SUB, install_code: IC }) });
  h = await hb(token);
  assert('token lama superseded → revoked', h.d && h.d.license_status === 'revoked', JSON.stringify(h.d));
  h = await hb(iss2.d.token);
  assert('token baru active', h.d && h.d.valid === true);

  // token palsu (tanda tangan salah)
  h = await hb(token.slice(0, -4) + 'AAAA');
  assert('token rusak → invalid', h.d && h.d.valid === false && h.d.license_status === 'invalid', JSON.stringify(h.d));

  const list = await api('/api/list?q=' + IC);
  assert('list menampilkan instalasi', list.d && list.d.rows.some((r) => r.install_code === IC && r.kind === 'v3'));

  const del = await api('/api/install/' + IC, { method: 'DELETE' });
  assert('hapus instalasi uji', del.status === 200);

  console.log(fails ? `\n${fails} test gagal` : '\nSemua test integrasi lulus');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
