// Inject CSS theme space ke file preview target
const fs = require('fs');
const target = process.argv[2] || 'tmp_voucher_desktop.html';
const html = fs.readFileSync(target, 'utf8');
const tokens = fs.readFileSync('public/css/theme-tokens.css', 'utf8');
const space = tokens.match(/\[data-app-theme="space"\]\s*\{[\s\S]*?\n\}/)[0];
const out = html.includes('data-theme-preview')
  ? html
  : html.replace('</head>', '<style data-theme-preview>' + space + '</style></head>');
fs.writeFileSync(target, out);
console.log('inject OK -> ' + target + ' len=' + out.length);