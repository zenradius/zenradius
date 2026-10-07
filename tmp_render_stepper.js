// Render voucher pending-order + inject space theme for visual check
const fs = require('fs'), ejs = require('ejs');
const b = {
  lang: 'id', brandVersion: '1', appTheme: 'space', company: 'ZenRadius',
  settings: { company_header: 'ZenRadius', company_phone: '1', company_email: 'a@b.c', company_address: 'Jl' },
  footerInfo: 'ZenRadius', t: (k, f) => f,
  profiles: [], paymentChannels: [], error: null, info: null, query: '', customer: null,
  invoices: [], unpaidInvoices: [], matches: [], invoiceTokens: {}, orderToken: 'abc',
  order: { id: 123, buyer_phone: '6281234567890', status: 'pending', profile_name: 'Paket 30M', validity: '30 Hari', price: 150000, payment_gateway: 'tripay', payment_link: 'https://x', voucher_code: null }
};
try {
  const h = ejs.render(fs.readFileSync('views/public_voucher.ejs', 'utf8'), b, { filename: 'views/public_voucher.ejs' });
  const tokens = fs.readFileSync('public/css/theme-tokens.css', 'utf8');
  const space = tokens.match(/\[data-app-theme="space"\]\s*\{[\s\S]*?\n\}/)[0];
  fs.writeFileSync('tmp_voucher_render.html', h.replace('</head>', '<style data-theme-preview>' + space + '</style></head>'));
  console.log('OK len=' + h.length);
} catch (e) { console.log('FAIL: ' + e.message.split('\n')[0]); }