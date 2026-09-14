// scripts/export-seed-db.js
// Buat salinan database "contoh" yang bersih dari data sensitif/transaksional,
// lalu simpan ke database/seed/zenradius-seed.db (di-commit ke Git).
// Saat aplikasi pertama kali dijalankan tanpa database, file seed ini akan disalin otomatis.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SRC = path.join(__dirname, '..', '..', 'database', 'zenradius.db');
const OUT_DIR = path.join(__dirname, '..', '..', 'database', 'seed');
const OUT = path.join(OUT_DIR, 'zenradius-seed.db');

// Tabel yang isinya DIHAPUS pada seed (data runtime / sensitif / transaksi)
const CLEAR_TABLES = [
  'sessions', 'audit_trail', 'payroll_slips',
  'public_donation_orders', 'public_voucher_orders',
  'customers', 'invoices', 'payments', 'tickets', 'attendance', 'attendance_photos',
  'push_subscriptions', 'whatsapp_messages', 'notifications', 'login_attempts',
];
// Kunci app_settings yang DIHAPUS pada seed
const CLEAR_SETTING_KEYS_LIKE = ['%license%', '%secret%', '%token%', '%password%', '%api_key%', '%apikey%', '%instance_id%', '%activation_key%', 'company_address'];

if (!fs.existsSync(SRC)) { console.error('Database sumber tidak ditemukan:', SRC); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

// Checkpoint WAL lalu salin via VACUUM INTO (menghasilkan file tunggal & compact)
const src = new Database(SRC);
src.pragma('wal_checkpoint(TRUNCATE)');
src.exec(`VACUUM INTO '${OUT.replace(/\\/g, '/').replace(/'/g, "''")}'`);
src.close();

const seed = new Database(OUT);
seed.pragma('journal_mode = DELETE');
const tables = new Set(seed.prepare("select name from sqlite_master where type='table'").all().map(r => r.name));
for (const t of CLEAR_TABLES) if (tables.has(t)) seed.exec(`DELETE FROM "${t}"`);
if (tables.has('app_settings')) {
  const cols = seed.prepare("pragma table_info('app_settings')").all().map(c => c.name);
  const keyCol = cols.includes('key') ? 'key' : (cols.includes('setting_key') ? 'setting_key' : cols.includes('name') ? 'name' : null);
  if (keyCol) for (const like of CLEAR_SETTING_KEYS_LIKE) seed.prepare(`DELETE FROM app_settings WHERE lower("${keyCol}") LIKE ?`).run(like);
}
if (tables.has('sqlite_sequence')) seed.exec("DELETE FROM sqlite_sequence WHERE name IN (" + CLEAR_TABLES.map(t => `'${t}'`).join(',') + ")");
seed.exec('VACUUM');

console.log('Seed dibuat:', OUT, `(${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const name of [...tables].sort()) {
  if (name.startsWith('sqlite_')) continue;
  const n = seed.prepare(`select count(*) n from "${name}"`).get().n;
  if (n > 0) console.log('  ', name.padEnd(30), n);
}
seed.close();
