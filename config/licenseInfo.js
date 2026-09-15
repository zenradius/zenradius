/**
 * Informasi komersial lisensi domain ZenRadius.
 * Satu sumber kebenaran untuk harga, kontak Developer, dan teks order,
 * agar tidak perlu mengubah di banyak tempat (settings, halaman kunci, banner).
 */
const LICENSE_PRICE = 300000;
const LICENSE_PRICE_LABEL = 'Rp 300.000 (Lifetime)';
const LICENSE_WA_NUMBER = '6285178008881'; // format internasional tanpa +
const LICENSE_WA_DISPLAY = '+62 851-7800-8881';

/** Masa tenggang (hari) sebelum akses dikunci penuh saat lisensi tidak valid. */
const LICENSE_GRACE_DAYS = 7;
/** Token v3: maksimal hari tanpa kontak registry sebelum lisensi dianggap perlu verifikasi ulang (lalu masuk masa tenggang). */
const LICENSE_OFFLINE_MAX_DAYS = 45;

function buildOrderMessage(domain, installCode = '') {
  const isLocal = String(domain || '').toLowerCase() === 'local';
  return [
    'Halo Developer ZenRadius,',
    '',
    `Saya ingin memesan Lisensi Premium Seumur Hidup (Lifetime) ZenRadius untuk ${isLocal ? 'instalasi lokal berikut' : 'domain berikut'}:`,
    '',
    `${isLocal ? '🖥️ INSTALASI LOKAL' : '🌐 DOMAIN'}: ${domain || '-'}`,
    ...(installCode ? [`🔑 KODE INSTALASI: ${installCode}`] : []),
    `💰 HARGA: ${LICENSE_PRICE_LABEL} (1 instalasi, seumur hidup)`,
    '',
    `Mohon informasikan metode pembayarannya. Setelah pembayaran, harap terbitkan Token Lisensi resmi untuk ${isLocal ? 'Kode Instalasi di atas' : 'domain dan Kode Instalasi di atas'}.`,
    '',
    'Terima kasih atas dedikasinya mengembangkan ZenRadius.'
  ].join('\n');
}

function buildOrderUrl(domain, installCode = '') {
  return `https://wa.me/${LICENSE_WA_NUMBER}?text=${encodeURIComponent(buildOrderMessage(domain, installCode))}`;
}

module.exports = {
  LICENSE_PRICE,
  LICENSE_PRICE_LABEL,
  LICENSE_WA_NUMBER,
  LICENSE_WA_DISPLAY,
  LICENSE_GRACE_DAYS,
  LICENSE_OFFLINE_MAX_DAYS,
  buildOrderMessage,
  buildOrderUrl
};
