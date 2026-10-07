// Temukan posisi kurung { yang tidak seimbang di dalam <style> public_voucher
const fs = require('fs');
const c = fs.readFileSync('views/public_voucher.ejs', 'utf8');
const m = c.match(/<style>([\s\S]*?)<\/style>/);
const css = m[1];
// Bersihkan komentar & string
let clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
clean = clean.replace(/'(?:[^'\\]|\\.)*'/g, "''");
clean = clean.replace(/"(?:[^"\\]|\\.)*"/g, '""');
// juga hapus blok @media interior braces? tidak — @media punya kurung sah.

let depth = 0;
let line = 1;
const problems = [];
for (let i = 0; i < clean.length; i++) {
  if (clean[i] === '\n') line++;
  if (clean[i] === '{') depth++;
  else if (clean[i] === '}') {
    depth--;
    if (depth < 0) {
      problems.push('Kurung tutup ekstra di baris ~' + line);
      depth = 0;
    }
  }
}
console.log('Depth akhir:', depth);
if (depth > 0) console.log('⚠️ Ada ' + depth + ' kurung buka yang TIDAK ditutup');

// Tampilkan posisi sekitar kurung terbuka yang tidak tertutup: cek baris2 yang dalam
// Kembalikan posisi line number dari baris-baris yang kedalaman 'profile' tinggi saat EOF
// Pendekatan: simulasi depth, catat baris ketika depth maksimum tercapai di akhir
const lines = clean.split('\n');
depth = 0;
const lineDepths = [];
for (const ln of lines) {
  for (const ch of ln) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  lineDepths.push(depth);
}
// cari baris-baris terakhir dengan depth > 0 dan blok terakhir yang tidak pernah ditutup
console.log('\nDepth per baris (10 terakhir):');
for (let i = Math.max(0, lines.length - 10); i < lines.length; i++) {
  console.log('L' + (i + 1) + ' depth=' + lineDepths[i] + ': ' + lines[i].slice(0, 90));
}
// cari di mana 'depth naik' terakhir kali dan tidak turun
console.log('\nBaris-baris dengan depth tertinggi di akhir file:');
let maxD = 0;
for (let i = 0; i < lineDepths.length; i++) maxD = Math.max(maxD, lineDepths[i]);
console.log('Max depth di file:', maxD);