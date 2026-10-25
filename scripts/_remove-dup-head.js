'use strict';
/**
 * Hapus blok "phead" hasil migrasi dari setiap halaman POS.
 * Header kini dikelola satu tempat di partials/head.ejs, sehingga halaman
 * cukup berisi kontennya sendiri.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'views', 'toko');
let n = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.ejs'))) {
  const p = path.join(DIR, f);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes('<div class="phead">')) continue;

  // Buang dari baris komentar "<!-- Header halaman" hingga penutup "</div>"
  // yang mengakhiri blok <nav class="pseg">.
  const out = src.replace(
    /<!-- Header halaman \+ navigasi cepat antar-halaman POS -->\r?\n<div class="phead">[\s\S]*?<\/nav>\r?\n<\/div>\r?\n/,
    ''
  );

  if (out !== src) {
    fs.writeFileSync(p, out, 'utf8');
    n++;
    console.log(`  [UBAH] ${f}`);
  } else {
    console.log(`  [GAGAL hapus] ${f}`);
  }
}

console.log(`${n} berkas dibersihkan.`);
