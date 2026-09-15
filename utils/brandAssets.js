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
const BRANDING_DIR = path.join(ROOT, 'public', 'uploads', 'branding');
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

/**
 * Versi cache-buster untuk URL logo/ikon. Berubah setiap kali file logo
 * diganti (berbasis mtime), sehingga CDN/Cloudflare & browser mengambil ulang.
 */
function getBrandVersion() {
  let latest = 0;
  for (const name of ['logo.png', 'icon.png']) {
    try {
      latest = Math.max(latest, fs.statSync(resolveBrandFile(name)).mtimeMs);
    } catch { /* file default mungkin tidak ada */ }
  }
  return latest > 0 ? String(Math.floor(latest)) : 'zenradius';
}

module.exports = { BRANDING_DIR, ensureBrandingDir, resolveBrandFile, saveBrandLogo, saveBrandIcon, hasCustomLogo, getBrandVersion };
