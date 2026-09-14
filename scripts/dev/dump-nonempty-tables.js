const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.argv[2] || '../../database/zenradius.db';
const db = new Database(path.resolve(__dirname, dbPath), { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
let total = 0;
console.log(`--- Non-empty tables in ${dbPath} ---`);
tables.forEach(t => {
  try {
    const c = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
    if (c > 0) {
      console.log(`${t}: ${c}`);
      total += c;
    }
  } catch (e) {}
});
console.log('TOTAL rows (non-empty tables):', total);
db.close();
