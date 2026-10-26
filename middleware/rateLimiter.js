let loginRateLimiter = (req, res, next) => next();

try {
  const rateLimit = require('express-rate-limit');
  loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(429).json({
          ok: false,
          error: 'Terlalu banyak percobaan login. Silakan coba lagi dalam 15 menit.'
        });
      }
      return res.status(429).send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Akses Dibatasi | Keamanan Portal</title>
          <style>
            body { display:flex; align-items:center; justify-content:center; min-height:100vh; background:#0f172a; color:#f8fafc; font-family:system-ui, -apple-system, sans-serif; margin:0; }
            .card-limit { background:#1e293b; padding:32px; border-radius:12px; border:1px solid #334155; text-align:center; max-width:420px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
            .card-limit h3 { color:#ef4444; margin-top:0; margin-bottom:12px; font-size:20px; }
            .card-limit p { color:#94a3b8; font-size:14px; line-height:1.5; margin-bottom:24px; }
            .btn-back { display:inline-block; padding:10px 20px; background:#3b82f6; color:#fff; text-decoration:none; border-radius:8px; font-size:14px; font-weight:600; }
            .btn-back:hover { background:#2563eb; }
          </style>
        </head>
        <body>
          <div class="card-limit">
            <h3>🚫 Terlalu Banyak Percobaan Login</h3>
            <p>Sistem keamanan mendeteksi terlalu banyak percobaan login dari IP/perangkat Anda. Untuk mencegah akses tanpa izin, login dibatasi sementara selama 15 menit.</p>
            <a href="javascript:history.back()" class="btn-back">Kembali ke Halaman Login</a>
          </div>
        </body>
        </html>
      `);
    }
  });
} catch (e) {

  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 10;
  const hits = new Map();

  loginRateLimiter = (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.connection?.remoteAddress || 'unknown');

    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    }

    const rec = hits.get(ip);
    if (!rec || now - rec.start > WINDOW_MS) {
      hits.set(ip, { start: now, count: 1 });
      return next();
    }

    rec.count++;
    if (rec.count > MAX_ATTEMPTS) {
      const msg = 'Terlalu banyak percobaan login. Silakan coba lagi dalam 15 menit.';
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(429).json({ ok: false, error: msg });
      }
      return res.status(429).send(msg);
    }
    return next();
  };
}

/**
 * Limiter khusus pembuatan challenge QR login Admin.
 *
 * Dipisahkan dari `loginRateLimiter` karena sifatnya berbeda:
 *  - `loginRateLimiter` membatasi PERCOBAAN MENEBAK kata sandi -> harus ketat.
 *  - QR dibuat OTOMATIS setiap halaman login dibuka dan setiap kali pengguna
 *    menekan "Muat Ulang QR", sehingga wajar terjadi berkali-kali.
 *
 * Bila keduanya memakai limiter yang sama, membuka atau menyegarkan halaman
 * login beberapa kali akan menghabiskan jatah percobaan login kata sandi dan
 * mengunci Admin dari cara masuk yang utama. Batas QR dibuat lebih longgar,
 * namun tetap terbatas untuk mencegah penyalahgunaan pembuatan challenge.
 */
let qrChallengeRateLimiter = (req, res, next) => next();

try {
  const rateLimit = require('express-rate-limit');
  qrChallengeRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({
        success: false,
        error: {
          code: 'QR_RATE_LIMITED',
          message: 'Terlalu sering membuat QR login. Tunggu beberapa menit lalu muat ulang halaman.'
        }
      });
    }
  });
} catch (e) {
  /* Cadangan bila express-rate-limit tidak tersedia (perilaku sama). */
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_QR_ATTEMPTS = 60;
  const qrHits = new Map();

  qrChallengeRateLimiter = (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.connection?.remoteAddress || 'unknown');

    if (qrHits.size > 5000) {
      for (const [k, v] of qrHits) if (now - v.start > WINDOW_MS) qrHits.delete(k);
    }

    const rec = qrHits.get(ip);
    if (!rec || now - rec.start > WINDOW_MS) {
      qrHits.set(ip, { start: now, count: 1 });
      return next();
    }

    rec.count++;
    if (rec.count > MAX_QR_ATTEMPTS) {
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({
        success: false,
        error: {
          code: 'QR_RATE_LIMITED',
          message: 'Terlalu sering membuat QR login. Tunggu beberapa menit lalu muat ulang halaman.'
        }
      });
    }
    return next();
  };
}

let voucherPurchaseRateLimiter = (req, res, next) => next();

try {
  const rateLimit = require('express-rate-limit');
  voucherPurchaseRateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    handler: (req, res) => {
      const msg = 'Terlalu banyak percobaan pembelian voucher dari perangkat/IP Anda. Silakan coba lagi dalam beberapa menit.';
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(429).json({ ok: false, error: msg });
      }
      return res.redirect('/customer/voucher?err=' + encodeURIComponent(msg));
    }
  });
} catch (e) {
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX_ATTEMPTS = 8;
  const hits = new Map();

  voucherPurchaseRateLimiter = (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.connection?.remoteAddress || 'unknown');

    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    }

    const rec = hits.get(ip);
    if (!rec || now - rec.start > WINDOW_MS) {
      hits.set(ip, { start: now, count: 1 });
      return next();
    }

    rec.count++;
    if (rec.count > MAX_ATTEMPTS) {
      const msg = 'Terlalu banyak percobaan pembelian voucher dari perangkat/IP Anda. Silakan coba lagi dalam beberapa menit.';
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(429).json({ ok: false, error: msg });
      }
      return res.redirect('/customer/voucher?err=' + encodeURIComponent(msg));
    }
    return next();
  };
}

/* Seluruh ekspor dikumpulkan di satu tempat pada akhir berkas. Sebelumnya
   ada dua `module.exports` terpisah yang mudah tidak sengaja saling menimpa. */
module.exports = {
  loginRateLimiter,
  qrChallengeRateLimiter,
  voucherPurchaseRateLimiter
};
