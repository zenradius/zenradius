'use strict';
/**
 * Transformasi satu kali: ubah 10 halaman POS dari tata letak "menempel di
 * panel admin" menjadi aplikasi mandiri.
 *
 *  - Ganti include 'partials/nav' (tab internal) dengan blok header halaman.
 *  - Ganti penutup </div></div><!-- /.page /.mw --> dengan penutup shell POS.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'views', 'toko');

const HEADER = `<!-- Header halaman + navigasi cepat antar-halaman POS -->
<div class="phead">
  <div class="phead-row">
    <h1 class="phead-h1"><%= title %></h1>
    <div class="phead-acts"><%- typeof pageActions !== 'undefined' && pageActions ? pageActions : '' %></div>
  </div>
  <nav class="pseg" aria-label="Navigasi Point of Sale">
    <a href="/toko" class="pseg-i <%= activeTab === 'dashboard' ? 'active' : '' %>"><i class="bi bi-grid-1x2"></i><span>Ringkasan</span></a>
    <a href="/toko/kasir" class="pseg-i <%= activeTab === 'kasir' ? 'active' : '' %>"><i class="bi bi-cart-check"></i><span>Kasir</span></a>
    <a href="/toko/produk" class="pseg-i <%= activeTab === 'produk' ? 'active' : '' %>"><i class="bi bi-box-seam"></i><span>Produk</span></a>
    <a href="/toko/pembelian" class="pseg-i <%= activeTab === 'pembelian' ? 'active' : '' %>"><i class="bi bi-truck"></i><span>Pembelian</span></a>
    <a href="/toko/pelanggan" class="pseg-i <%= activeTab === 'pelanggan' ? 'active' : '' %>"><i class="bi bi-people"></i><span>Pelanggan</span></a>
    <a href="/toko/hutang" class="pseg-i <%= activeTab === 'hutang' ? 'active' : '' %>"><i class="bi bi-cash-coin"></i><span>Piutang</span></a>
    <a href="/toko/kas" class="pseg-i <%= activeTab === 'kas' ? 'active' : '' %>"><i class="bi bi-wallet2"></i><span>Buku Kas</span></a>
    <a href="/toko/shift" class="pseg-i <%= activeTab === 'shift' ? 'active' : '' %>"><i class="bi bi-clock-history"></i><span>Shift</span></a>
    <a href="/toko/laporan" class="pseg-i <%= activeTab === 'laporan' ? 'active' : '' %>"><i class="bi bi-bar-chart-line"></i><span>Laporan</span></a>
    <% if (typeof session !== 'undefined' && session && session.isAdmin) { %>
      <a href="/toko/pengaturan" class="pseg-i <%= activeTab === 'pengaturan' ? 'active' : '' %>"><i class="bi bi-sliders"></i><span>Pengaturan</span></a>
    <% } %>
  </nav>
</div>`;

const CLOSE = '</div><!-- /.pbody -->\n</div><!-- /.pmain -->\n</div><!-- /.pshell -->';

const OLD_CLOSE = '</div></div><!-- /.page /.mw -->';

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ejs') && f !== 'struk.ejs');
let changed = 0;

for (const name of files) {
  const file = path.join(DIR, name);
  let src = fs.readFileSync(file, 'utf8');
  const before = src;

  // 1. Buang include nav (tab internal).
  src = src.replace(/^<%- include\('partials\/nav', \{ activeTab: '[^']*' \} %>\r?\n/m, '');

  // 2. Selipkan header tepat setelah include head.
  src = src.replace(
    /^(<%- include\('partials\/head',[^\n]*%>\r?\n)/m,
    `$1\n${HEADER}\n`
  );

  // 3. Ganti penutup shell.
  if (src.includes(OLD_CLOSE)) {
    src = src.replace(OLD_CLOSE, CLOSE);
  } else {
    console.log(`  [LEWAT] ${name}: penanda penutup lama tidak ditemukan`);
  }

  if (src !== before) {
    fs.writeFileSync(file, src, 'utf8');
    changed++;
    console.log(`  [UBAH]  ${name}`);
  }
}

console.log(`\n${changed} berkas diubah.`);
