// Render public_voucher dengan data realistis untuk cek visual
const fs = require('fs'), ejs = require('ejs');
const b = {
  lang: 'id', brandVersion: '1', appTheme: 'space', company: 'ZenRadius',
  settings: {
    company_header: 'ZenRadius', company_phone: '081234567890',
    company_email: 'cs@zenradius.id', company_address: 'Jl. Contoh No. 1'
  },
  footerInfo: 'ZenRadius', t: (k, f) => f,
  profiles: [{ id: 1, speed_down: 30000, speed_up: 15000, price: 150000, duration_days: 30, name: 'Paket Hemat 30 Mbps', description: 'Kecepatan 30 Mbps, kuota unlimited', is_active: 1 }],
  paymentChannels: [
    { code: 'QRIS', name: 'QRIS', group: 'QRIS', active: true },
    { code: 'BCAVA', name: 'BCA VA', group: 'Virtual Account', active: true },
    { code: 'DANA', name: 'DANA', group: 'E-Wallet', active: true }
  ],
  error: null, info: null, query: '', customer: null,
  invoices: [], unpaidInvoices: [], matches: [], invoiceTokens: {}
};
try {
  const h = ejs.render(fs.readFileSync('views/public_voucher.ejs', 'utf8'), b, { filename: 'views/public_voucher.ejs' });
  fs.writeFileSync('tmp_voucher_preview.html', h);
  console.log('OK render len=' + h.length);
} catch (e) { console.log('FAIL: ' + e.message.split('\n')[0]); }