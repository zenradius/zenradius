/**
 * ZenRadius License Registry — Cloudflare Worker
 *
 * Endpoints:
 *   POST /api/issue       (Admin token)  catat serial yang diterbitkan KeyGen
 *   POST /api/heartbeat   (publik, tervalidasi HMAC + rate limit) ping harian dari server ZenRadius
 *   GET  /api/list        (Admin token)  daftar lisensi + instalasi
 *   GET  /api/stats       (Admin token)  ringkasan angka
 *   DELETE /api/license/:domain (Admin token)
 *   GET  /health
 *
 * Secrets (wrangler secret put):
 *   ADMIN_TOKEN     token dashboard KeyGen
 *   MASTER_SECRET   sama dengan MASTER_SECRET di domainLicenseService.js
 * Vars:
 *   ALLOWED_ORIGIN  origin KeyGen (CORS), mis. https://license.zenradius.net
 */

const SERIAL_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DOMAIN_RE = /^[a-z0-9.-]{1,253}$/;

function normalizeDomain(input) {
  return String(input || '').trim().toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .split('/')[0].split(':')[0];
}

async function computeSerial(secret, domain) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(domain));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, 16);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
  });
}

function corsHeaders(env, req) {
  const origin = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? origin : allowed[0] || '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    'vary': 'origin'
  };
}

function isAdmin(env, req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return Boolean(env.ADMIN_TOKEN) && token.length > 0 && timingSafeEqual(token, env.ADMIN_TOKEN);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Rate limit sederhana per IP+domain untuk heartbeat (KV opsional; fallback ke header only)
async function rateLimited(env, key, limit, windowSec) {
  if (!env.RATE_KV) return false;
  const now = Math.floor(Date.now() / 1000);
  const bucket = `${key}:${Math.floor(now / windowSec)}`;
  const cur = parseInt((await env.RATE_KV.get(bucket)) || '0', 10);
  if (cur >= limit) return true;
  await env.RATE_KV.put(bucket, String(cur + 1), { expirationTtl: windowSec * 2 });
  return false;
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(env, req);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (path === '/health') return json({ ok: true, ts: Date.now() }, 200, cors);

      // ── Heartbeat (publik) ──
      if (path === '/api/heartbeat' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return json({ error: 'bad_json' }, 400, cors);
        const domain = normalizeDomain(body.domain);
        if (!domain || !DOMAIN_RE.test(domain)) return json({ error: 'bad_domain' }, 400, cors);
        if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(domain)) return json({ ok: true, skipped: 'local' }, 200, cors);

        const ip = req.headers.get('cf-connecting-ip') || '';
        if (await rateLimited(env, `hb:${ip}:${domain}`, 12, 3600)) return json({ error: 'rate_limited' }, 429, cors);

        const serial = String(body.serial || '').trim().toUpperCase();
        let valid = 0;
        if (SERIAL_RE.test(serial) && env.MASTER_SECRET) {
          valid = (await computeSerial(env.MASTER_SECRET, domain)) === serial ? 1 : 0;
        }
        const now = Date.now();
        const country = req.cf?.country || '';
        await env.DB.prepare(`
          INSERT INTO installs (domain, serial, license_valid, app_version, node_version, first_seen, last_seen, ip, country, hits)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, 1)
          ON CONFLICT(domain) DO UPDATE SET
            serial = excluded.serial,
            license_valid = excluded.license_valid,
            app_version = excluded.app_version,
            node_version = excluded.node_version,
            last_seen = excluded.last_seen,
            ip = excluded.ip,
            country = excluded.country,
            hits = installs.hits + 1
        `).bind(domain, serial || null, valid, String(body.app_version || '').slice(0, 40), String(body.node_version || '').slice(0, 40), now, ip, country).run();

        return json({ ok: true, valid: Boolean(valid) }, 200, cors);
      }

      // ── Semua di bawah ini butuh Admin token ──
      if (!isAdmin(env, req)) return json({ error: 'unauthorized' }, 401, cors);

      if (path === '/api/issue' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body) return json({ error: 'bad_json' }, 400, cors);
        const domain = normalizeDomain(body.domain);
        const serial = String(body.serial || '').trim().toUpperCase();
        if (!domain || !DOMAIN_RE.test(domain)) return json({ error: 'bad_domain' }, 400, cors);
        if (!SERIAL_RE.test(serial)) return json({ error: 'bad_serial' }, 400, cors);
        // Verifikasi serial memang sah untuk domain tsb (mencegah salah catat)
        if (env.MASTER_SECRET) {
          const expected = await computeSerial(env.MASTER_SECRET, domain);
          if (expected !== serial) return json({ error: 'serial_mismatch' }, 422, cors);
        }
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO licenses (domain, serial, issued_at, issued_by, note) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(domain) DO UPDATE SET serial = excluded.serial, issued_at = excluded.issued_at, issued_by = excluded.issued_by, note = COALESCE(excluded.note, licenses.note)
        `).bind(domain, serial, now, String(body.issued_by || '').slice(0, 80), body.note ? String(body.note).slice(0, 200) : null).run();
        return json({ ok: true, domain, serial, issued_at: now }, 200, cors);
      }

      if (path === '/api/list' && req.method === 'GET') {
        const q = normalizeDomain(url.searchParams.get('q') || '');
        const like = q ? `%${q}%` : '%';
        const rows = await env.DB.prepare(`
          WITH all_domains AS (
            SELECT domain FROM licenses UNION SELECT domain FROM installs
          )
          SELECT
            d.domain,
            l.serial        AS issued_serial,
            l.issued_at,
            l.issued_by,
            l.note,
            i.serial        AS installed_serial,
            i.license_valid,
            i.app_version,
            i.first_seen,
            i.last_seen,
            i.country,
            i.hits
          FROM all_domains d
          LEFT JOIN licenses l ON l.domain = d.domain
          LEFT JOIN installs i ON i.domain = d.domain
          WHERE d.domain LIKE ?1
          ORDER BY COALESCE(i.last_seen, l.issued_at) DESC
          LIMIT 1000
        `).bind(like).all();
        return json({ ok: true, rows: rows.results || [] }, 200, cors);
      }

      if (path === '/api/stats' && req.method === 'GET') {
        const now = Date.now();
        const d7 = now - 7 * 86400000;
        const d30 = now - 30 * 86400000;
        const [lic, inst, act7, act30, valid, invalid] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) c FROM licenses').first('c'),
          env.DB.prepare('SELECT COUNT(*) c FROM installs').first('c'),
          env.DB.prepare('SELECT COUNT(*) c FROM installs WHERE last_seen >= ?1').bind(d7).first('c'),
          env.DB.prepare('SELECT COUNT(*) c FROM installs WHERE last_seen >= ?1').bind(d30).first('c'),
          env.DB.prepare('SELECT COUNT(*) c FROM installs WHERE license_valid = 1 AND last_seen >= ?1').bind(d30).first('c'),
          env.DB.prepare('SELECT COUNT(*) c FROM installs WHERE license_valid = 0 AND last_seen >= ?1').bind(d30).first('c')
        ]);
        return json({
          ok: true,
          issued: lic || 0,
          installs_total: inst || 0,
          active_7d: act7 || 0,
          active_30d: act30 || 0,
          licensed_30d: valid || 0,
          unlicensed_30d: invalid || 0
        }, 200, cors);
      }

      const m = path.match(/^\/api\/license\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const domain = normalizeDomain(decodeURIComponent(m[1]));
        await env.DB.prepare('DELETE FROM licenses WHERE domain = ?1').bind(domain).run();
        return json({ ok: true, domain }, 200, cors);
      }

      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ error: 'server_error', detail: String(e && e.message || e) }, 500, cors);
    }
  }
};
