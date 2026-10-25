'use strict';
/**
 * Resolusi file logo/ikon aplikasi.
 *
 * Logo yang di-upload dari panel admin disimpan di public/uploads/branding/
 * (direktori ini adalah bind-mount volume di Docker dan writable oleh user
 * `node`). File default tetap ada di public/img/ dan hanya dipakai jika
 * belum ada logo custom. Dengan begitu logo custom tidak hilang saat
 * container di-rebuild dan tidak gagal karena EACCES di /app/public/img.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// BRANDING_DIR dapat diarahkan ke folder lain (dipakai pengujian) agar logo
// toko tidak pernah menimpa berkas produksi saat uji dijalankan.
const BRANDING_DIR = process.env.ZENRADIUS_BRANDING_DIR
  ? path.resolve(process.env.ZENRADIUS_BRANDING_DIR)
  : path.join(ROOT, 'public', 'uploads', 'branding');
const DEFAULT_DIR = path.join(ROOT, 'public', 'img');

function ensureBrandingDir() {
  if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true });
  return BRANDING_DIR;
}

function customPath(name) { return path.join(BRANDING_DIR, name); }
function defaultPath(name) { return path.join(DEFAULT_DIR, name); }

/** Path absolut file yang harus disajikan untuk /img/<name> (logo.png | icon.png). */
function resolveBrandFile(name) {
  const c = customPath(name);
  if (fs.existsSync(c)) return c;
  return defaultPath(name);
}

/** Simpan buffer sebagai logo custom. */
function saveBrandLogo(buffer) {
  ensureBrandingDir();
  fs.writeFileSync(customPath('logo.png'), buffer);
  return { logo: customPath('logo.png') };
}

/** Simpan buffer favicon/PWA icon custom secara terpisah dari logo utama. */
function saveBrandIcon(buffer) {
  ensureBrandingDir();
  fs.writeFileSync(customPath('icon.png'), buffer);
  return { icon: customPath('icon.png') };
}

function hasCustomLogo() { return fs.existsSync(customPath('logo.png')); }

/* ── Logo khusus toko (Point of Sale) ──
   Terpisah dari logo aplikasi supaya pemilik toko dapat memakai logo usahanya
   sendiri tanpa mengubah branding ZenRadius. Disimpan di folder branding yang
   sudah writable & ikut ter-backup (bind-mount volume di Docker).
   Format dibatasi PNG/JPEG dan dideteksi dari magic bytes, bukan dari nama
   berkas kiriman pengguna, agar isi berkas selalu cocok dengan ekstensinya. */
const STORE_LOGO_CANDIDATES = [
  { name: 'store-logo.png', mime: 'image/png' },
  { name: 'store-logo.jpg', mime: 'image/jpeg' }
];

/** Kenali format gambar dari magic bytes. Mengembalikan mime atau null. */
function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** Simpan logo toko. Format ditentukan dari isi berkas. */
function saveStoreLogo(buffer) {
  const mime = detectImageMime(buffer);
  if (!mime) throw new Error('Format logo tidak didukung. Gunakan PNG, JPG, atau WebP.');
  ensureBrandingDir();
  const target = STORE_LOGO_CANDIDATES.find((c) => c.mime === mime);
  if (!target) throw new Error('Format logo tidak didukung. Gunakan PNG atau JPG.');
  // Hapus varian lain agar hanya ada satu logo aktif.
  for (const c of STORE_LOGO_CANDIDATES) {
    if (c.name !== target.name) { try { fs.unlinkSync(customPath(c.name)); } catch { /* belum ada */ } }
  }
  fs.writeFileSync(customPath(target.name), buffer);
  return { path: customPath(target.name), mime: target.mime };
}

/** Lokasi logo toko aktif, atau null bila belum diunggah. */
function resolveStoreLogo() {
  for (const c of STORE_LOGO_CANDIDATES) {
    const p = customPath(c.name);
    if (fs.existsSync(p)) return { path: p, mime: c.mime };
  }
  return null;
}

function hasStoreLogo() { return resolveStoreLogo() !== null; }

/** Hapus logo toko (kembali memakai logo aplikasi). */
function removeStoreLogo() {
  let removed = false;
  for (const c of STORE_LOGO_CANDIDATES) {
    try { fs.unlinkSync(customPath(c.name)); removed = true; } catch { /* sudah tidak ada */ }
  }
  return removed;
}

/**
 * Versi cache-buster untuk URL logo/ikon. Berubah setiap kali file logo
 * diganti (berbasis mtime), sehingga CDN/Cloudflare & browser mengambil ulang.
 */
function getBrandVersion() {
  let latest = 0;
  for (const name of ['logo.png', 'icon.png', 'store-logo.png', 'store-logo.jpg']) {
    try {
      latest = Math.max(latest, fs.statSync(resolveBrandFile(name)).mtimeMs);
    } catch { /* file default mungkin tidak ada */ }
  }
  return latest > 0 ? String(Math.floor(latest)) : 'zenradius';
}

module.exports = {
  BRANDING_DIR,
  ensureBrandingDir,
  resolveBrandFile,
  saveBrandLogo,
  saveBrandIcon,
  hasCustomLogo,
  getBrandVersion,
  detectImageMime,
  saveStoreLogo,
  resolveStoreLogo,
  hasStoreLogo,
  removeStoreLogo
};
