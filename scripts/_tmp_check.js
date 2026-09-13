const db = require('../config/database');
console.log('RESULT', JSON.stringify({
  cashier_left: db.prepare("SELECT count(*) c FROM cashiers WHERE username='tkasir_perm'").get().c,
  perm_rows: db.prepare('SELECT count(*) c FROM user_permissions').get().c
}));
