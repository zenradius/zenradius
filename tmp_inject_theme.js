// Inject CSS theme space ke preview voucher
const fs = require('fs');
const html = fs.readFileSync('tmp_voucher_preview.html', 'utf8');
const tokens = fs.readFileSync('public/css/theme-tokens.css', 'utf8');
const space = tokens.match(/\[data-app-theme="space"\]\s*\{[\s\S]*?\n\}/)[0];
const out = html.replace('</head>', '<style data-theme-preview>' + space + '</style></head>');
fs.writeFileSync('tmp_voucher_preview.html', out);
console.log('inject OK, len=' + out.length);