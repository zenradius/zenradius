#!/usr/bin/env node
'use strict';

/**
 * Naikkan versi ZenRadius Web secara konsisten.
 *
 *   node scripts/bump-version.js 1.7.1     # set versi eksplisit
 *   node scripts/bump-version.js patch     # 1.7.0 → 1.7.1
 *   node scripts/bump-version.js minor     # 1.7.0 → 1.8.0
 *   node scripts/bump-version.js major     # 1.7.0 → 2.0.0
 *   node scripts/bump-version.js --check   # hanya periksa (exit 1 bila tak sinkron)
 *
 * Memperbarui SEKALIGUS:
 *   - version.txt      (V.x.y.z)
 *   - package.json     (version)
 *   - package-lock.json (version + packages[""].version)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const arg = String(process.argv[2] || '').trim();

const files = {
  versionTxt: path.join(ROOT, 'version.txt'),
  pkg: path.join(ROOT, 'package.json'),
  lock: path.join(ROOT, 'package-lock.json'),
};

function readVersionTxt() {
  try {
    return String(fs.readFileSync(files.versionTxt, 'utf8')).trim().replace(/^V\./i, '');
  } catch (_) { return ''; }
}

function readPkgVersion() {
  try { return String(JSON.parse(fs.readFileSync(files.pkg, 'utf8')).version || ''); }
  catch (_) { return ''; }
}

function nextSemver(cur, kind) {
  const m = String(cur || '0.0.0').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') { major += 1; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor += 1; patch = 0; }
  else { patch += 1; }
  return `${major}.${minor}.${patch}`;
}

/* ── Mode --check: pastikan version.txt & package.json sinkron ── */
if (arg === '--check' || arg === 'check') {
  const vTxt = readVersionTxt();
  const vPkg = readPkgVersion();
  const okTxt = /^\d+\.\d+\.\d+$/.test(vTxt);
  const okPkg = /^\d+\.\d+\.\d+$/.test(vPkg);
  const same = vTxt === vPkg;
  console.log(`version.txt  : ${vTxt || '(kosong)'}`);
  console.log(`package.json : ${vPkg || '(kosong)'}`);
  if (okTxt && okPkg && same) { console.log('✔ Versi sinkron.'); process.exit(0); }
  console.error('✘ Versi TIDAK sinkron — jalankan: node scripts/bump-version.js <versi|patch|minor|major>');
  process.exit(1);
}

/* ── Tentukan versi tujuan ── */
const current = readVersionTxt() || readPkgVersion();
if (!arg) {
  console.error('Penggunaan: node scripts/bump-version.js <versi|patch|minor|major|--check>');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(arg) && !['patch', 'minor', 'major'].includes(arg)) {
  console.error(`✘ Argumen tidak dikenal: "${arg}". Gunakan patch | minor | major | x.y.z | --check`);
  process.exit(2);
}
const target = /^\d+\.\d+\.\d+$/.test(arg) ? arg : nextSemver(current, arg);
if (!target) {
  console.error(`✘ Versi saat ini tidak valid ("${current}") atau argumen salah: "${arg}"`);
  process.exit(2);
}

/* ── Tulis semua berkas ── */
fs.writeFileSync(files.versionTxt, `V.${target}\n`, 'utf8');
console.log(`version.txt      -> V.${target}`);

if (fs.existsSync(files.pkg)) {
  const pkg = JSON.parse(fs.readFileSync(files.pkg, 'utf8'));
  pkg.version = target;
  fs.writeFileSync(files.pkg, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`package.json     -> ${target}`);
}

if (fs.existsSync(files.lock)) {
  const lock = JSON.parse(fs.readFileSync(files.lock, 'utf8'));
  lock.version = target;
  if (lock.packages && lock.packages['']) lock.packages[''].version = target;
  fs.writeFileSync(files.lock, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  console.log(`package-lock.json-> ${target}`);
}

console.log(`\n✔ Versi dinaikkan: ${current} → ${target}`);
