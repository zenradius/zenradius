const Database = require('C:/ZenRadius/zenradius/node_modules/better-sqlite3');
const db = Database('C:/ZenRadius/zenradius/data/zenradius.db', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log('TABLES:', tables.join(', '));
const tab = tables.find(t => t.includes('voucher') || t === 'invoices');
console.log('picked:', tab);