'use strict';
/** Hapus sisa baris include partials/nav dari halaman POS. */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'views', 'toko');
const NEEDLE = "include('partials/nav'";
let n = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.ejs'))) {
  const p = path.join(DIR, f);
  const src = fs.readFileSync(p, 'utf8');
  const out = src.split(/\r?\n/).filter((l) => !l.includes(NEEDLE)).join('\n');
  if (out !== src) {
    fs.writeFileSync(p, out, 'utf8');
    n++;
    console.log(`  bersih: ${f}`);
  }
}
console.log(`${n} berkas dibersihkan`);
