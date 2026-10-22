/**
 * License Client Service
 * Klien verifikasi lisensi ONLINE ke server lisensi resmi (zenradius-web).
 *
 * Skema lisensi (v4): KODE LISENSI sederhana XXXX-XXXX-XXXX-XXXX
 * (contoh BG23-SJH2-HDGT-5582) yang terikat pada Kode Instalasi.
 * Tidak ada tanda tangan kripto — server lisensi yang memutuskan valid/tidak
 * lewat POST /api/verify, sehingga kode tidak dapat dipalsukan atau dihitung
 * sendiri oleh pemilik source code.
 *
 * Semua panggilan bersifat fail-safe: kegagalan jaringan tidak pernah
 * menggagalkan permintaan pengguna (dikembalikan sebagai {ok:false, error}).
 */
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');

const TIMEOUT_MS = 8000;

/** URL server lisensi: setting license_web_url → env → default resmi. */
function baseUrl() {
  const candidates = [
    getSetting('license_web_url', ''),
    process.env.ZENRADIUS_LICENSE_URL,
    process.env.ZENRADIUS_REGISTRY_URL,
    'https://license.zenradius.net',
  ];
  for (const raw of candidates) {
    let s = String(raw || '').trim();
    if (!s) continue;
    // Terima format apa pun: buang path /api/... bila ada.
    s = s.replace(/\/+$/, '').replace(/\/api\/(verify|heartbeat|registry\/lookup)$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }
  return 'https://license.zenradius.net';
}

function endpoints() {
  const b = baseUrl();
  return { verify: `${b}/api/verify`, heartbeat: `${b}/api/heartbeat` };
}

/** POST JSON dengan timeout; tidak pernah melempar. */
async function postJson(url, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'ZenRadius-LicenseClient/1.0' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) return { ok: false, httpStatus: res.status, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'network_error' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Verifikasi kode lisensi ke server (ONLINE).
 * @param {{code:string, installCode:string, domain?:string}} input
 * @returns {Promise<{ok:boolean, valid?:boolean, reason?:string, grace?:boolean,
 *                    expires_at?:string|null, days_left?:number|null,
 *                    httpStatus?:number, error?:string}>}
 */
async function verifyLicense({ code, installCode, domain }) {
  const payload = {
    code: String(code || '').trim(),
    install_code: String(installCode || '').trim(),
    domain: String(domain || '').trim().toLowerCase(),
  };
  if (!payload.code) return { ok: false, valid: false, reason: 'no_code' };

  const { verify } = endpoints();
  const r = await postJson(verify, payload);
  if (!r.ok) {
    logger.warn(`[license-client] Verifikasi online gagal: ${r.error || ('HTTP ' + r.httpStatus)}`);
    return { ok: false, reason: 'offline', httpStatus: r.httpStatus, error: r.error };
  }
  const d = r.data || {};
  return {
    ok: true,
    valid: d.valid === true,
    reason: d.reason || null,
    grace: d.grace === true,
    grace_end: d.grace_end || null,
    expires_at: d.expires_at === undefined ? null : d.expires_at,
    days_left: d.days_left === undefined ? null : d.days_left,
  };
}

/**
 * Kirim heartbeat instalasi (domain, kode lisensi, kode instalasi, versi).
 * Balasan dapat memuat status lisensi (active/revoked) untuk kebijakan revokasi.
 */
async function sendHeartbeat(payload) {
  const { heartbeat } = endpoints();
  return postJson(heartbeat, payload);
}

module.exports = { verifyLicense, sendHeartbeat, baseUrl, endpoints, TIMEOUT_MS };
