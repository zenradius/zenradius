'use strict';
/**
 * Sambungkan setiap halaman POS ke sidebar-nya:
 *  - Sisipkan `activeTab` pada include('partials/head', ...) agar menu aktif
 *    tersorot di sidebar maupun navigasi segmen.
 *  - Buang blok pageActions yang tidak dipakai dari header halaman.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'views', 'toko');

const TABS = {
  'dashboard.ejs': 'dashboard',
  'kasir.ejs': 'kasir',
  'produk.ejs': 'produk',
  'pembelian.ejs': 'pembelian',
  'hutang.ejs': 'hutang',
  'kas.ejs': 'kas',
  'shift.ejs': 'shift',
  'laporan.ejs': 'laporan',
  'pelanggan.ejs': 'pelanggan',
  'pengaturan.ejs': 'pengaturan'
};

let changed = 0;

for (const [file, tab] of Object.entries(TABS)) {
  const p = path.join(DIR, file);
  let src = fs.readFileSync(p, 'utf8');
  const before = src;

  // 1. Tambahkan activeTab (bentuk asli diakhiri "}) %>").
  if (!/include\('partials\/head'[^\n]*activeTab/.test(src)) {
    src = src.replace(
      /^<%- include\('partials\/head', \{ title: '([^']*)' \}\) %>/m,
      (_m, title) => `<%- include('partials/head', { title: '${title}', activeTab: '${tab}' }) %>`
    );
  }

  // 2. Buang baris pageActions dari header halaman.
  src = src.replace(/^\s*<div class="phead-acts">.*<\/div>\r?\n/m, '');

  if (src !== before) {
    fs.writeFileSync(p, src, 'utf8');
    changed++;
    console.log(`  [UBAH] ${file} -> activeTab: '${tab}'`);
  }
}

console.log(`\n${changed} berkas diubah.`);
