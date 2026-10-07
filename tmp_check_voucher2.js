const fs = require('fs'), ejs = require('ejs');
const c = fs.readFileSync('views/public_voucher.ejs', 'utf8');
try { ejs.compile(c, { filename: 'views/public_voucher.ejs' }); console.log('compile OK'); }
catch (e) { console.log('FAIL: ' + e.message.split('\n')[0]); }
const style = c.match(/<style>([\s\S]*?)<\/style>/);
const css = style[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
const o = (css.match(/\{/g) || []).length, cl = (css.match(/\}/g) || []).length;
console.log('CSS brace: ' + o + '/' + cl + (o === cl ? ' OK' : ' ⚠️ MISMATCH'));