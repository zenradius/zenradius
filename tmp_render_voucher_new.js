// Render voucher baru + inject theme inline
const fs = require('fs'), ejs = require('ejs');
const b = {
  lang: 'id', brandVersion: '1', appTheme: 'space', company: 'ZenRadius',
  settings: { company_header: 'ZenRadius', company_phone: '081234567890', company_email: 'cs@zenradius.id', company_address: 'Jl. Contoh No. 1' },
  footerInfo: 'ZenRadius', t: (k, f) => f,
  profiles: [
    { id: 1, speed_down: 30000, speed_up: 15000, price: 150000, validity: '30d', name: 'Paket Hemat 30 Mbps', description: 'Kecepatan 30 Mbps', is_active: 1 },
    { id: 2, speed_down: 50000, speed_up: 25000, price: 250000, validity: '30d', name: 'Paket Keluarga 50 Mbps', description: 'Kecepatan 50 Mbps', is_active: 1 },
    { id: 3, speed_down: 100000, speed_up: 50000, price: 400000, validity: '14d', name: 'Paket Bisnis 100 Mbps', description: 'Kecepatan 100 Mbps', is_active: 1 }
  ],
  paymentChannels: [
    { code: 'QRIS', name: 'QRIS', group: 'QRIS', active: true },
    { code: 'BCAVA', name: 'BCA Virtual Account', group: 'Virtual Account', active: true },
    { code: 'BNIVA', name: 'BNI Virtual Account', group: 'Virtual Account', active: true },
    { code: 'BRIVA', name: 'BRI Virtual Account', group: 'Virtual Account', active: true },
    { code: 'DANA', name: 'DANA', group: 'E-Wallet', active: true },
    { code: 'SHOPEEPAY', name: 'ShopeePay', group: 'E-Wallet', active: true }
  ],
  error: null, info: null, query: '', customer: null,
  invoices: [], unpaidInvoices: [], matches: [], invoiceTokens: {}, order: null
};
try {
  const h = ejs.render(fs.readFileSync('views/public_voucher.ejs', 'utf8'), b, { filename: 'views/public_voucher.ejs' });
  // inject theme space
  const tokens = fs.readFileSync('public/css/theme-tokens.css', 'utf8');
  const space = tokens.match(/\[data-app-theme="space"\]\s*\{[\s\S]*?\n\}/)[0];
  const out = h.replace('</head>', '<style data-theme-preview>' + space + '</style></head>');
  fs.writeFileSync('tmp_voucher_new.html', out);
  console.log('OK len=' + out.length);
} catch (e) { console.log('FAIL: ' + e.message.split('\n')[0]); }