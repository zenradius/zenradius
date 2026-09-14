// scripts/db-inspect.js — print non-empty tables with row counts
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'database', 'zenradius.db'), { readonly: true });
const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all();
for (const { name } of tables) {
  const n = db.prepare(`select count(*) n from "${name}"`).get().n;
  if (n > 0) console.log(name.padEnd(36), n);
}
