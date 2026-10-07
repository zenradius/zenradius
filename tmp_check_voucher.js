// Periksa halaman voucher publik: keseimbangan CSS brace & struktur visual
const fs = require('fs');
const c = fs.readFileSync('views/public_voucher.ejs', 'utf8');
console.log('Total chars:', c.length);

const styles = [...c.matchAll(/<style>([\s\S]*?)<\/style>/g)];
console.log('Blok <style>:', styles.length);
styles.forEach((s, i) => {
  const css = s[1];
  // buang komentar & string untuk akurasi brace
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const o = (clean.match(/\{/g) || []).length, cl = (clean.match(/\}/g) || []).length;
  console.log('Style#' + i + ': open=' + o + ' close=' + cl + (o === cl ? ' OK' : ' ⚠️ MISMATCH (' + (o - cl) + ')'));
});

// Cek brace di HTML secara umum (script tag balance)
const scripts = [...c.matchAll(/<script>([\s\S]*?)<\/script>/g)];
console.log('\nBlok <script>:', scripts.length);
scripts.forEach((s, i) => {
  const js = s[1];
  const o = (js.match(/\{/g) || []).length, cl = (js.match(/\}/g) || []).length;
  console.log('Script#' + i + ': open=' + o + ' close=' + cl + (o === cl ? ' OK' : ' ⚠️ MISMATCH (' + (o - cl) + ')'));
});

// Cek EJS compile
const ejs = require('ejs');
try { ejs.compile(c, { filename: 'views/public_voucher.ejs' }); console.log('\nEJS compile: OK'); }
catch (e) { console.log('\nEJS compile FAIL: ' + e.message.split('\n')[0]); }