'use strict';
/**
 * Hapus `activePage: MENU_KEY,` dari routes/posPortal.js.
 * Sejak halaman POS memakai sidebar sendiri (activeTab), variabel itu tidak
 * lagi dibaca oleh template mana pun.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'routes', 'posPortal.js');
const src = fs.readFileSync(file, 'utf8');
const before = src.split(/\r?\n/).length;

const out = src
  .split(/\r?\n/)
  .filter((l) => l.trim() !== 'activePage: MENU_KEY,')
  .join('\n');

const after = out.split(/\r?\n/).length;
fs.writeFileSync(file, out, 'utf8');
console.log(`Baris: ${before} -> ${after} (${before - after} baris dihapus)`);
