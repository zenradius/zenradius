<div align="center">

# ZenRadius

**One Platform for Your Network** 🚀

Platform manajemen billing ISP, otomasi jaringan Mikrotik, billing Hotspot/PPPoE, dan portal mandiri pelanggan (*Customer Self-Service*) — modern, responsif, dan siap produksi sebagai aplikasi web berbasis PWA (*Progressive Web App*).

![Node.js](https://img.shields.io/badge/Node.js-v18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-Framework-black?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8?logo=pwa&logoColor=white)
![License](https://img.shields.io/badge/License-Proprietary-red)

![ZenRadius Hero](public/img/hero.png)

</div>

---

### 🔗 Live Demo

**DEMO:** [https://demo.zenradius.net/admin](https://demo.zenradius.net/admin)
**LOGIN:** `zenradius` / `zenradius123`

---
## 📖 Daftar Isi

- [Fitur Utama](#-fitur-utama)
- [Integrasi Payment Gateway](#-integrasi-payment-gateway)
- [Tumpukan Teknologi](#-tumpukan-teknologi)
- [Persyaratan Sistem](#-persyaratan-sistem)
- [Instalasi via install.sh (VPS/Production)](#-instalasi-via-installsh-vpsproduction)
- [Menjalankan via Docker](#-menjalankan-via-docker-alternatif)
- [Konfigurasi Domain & HTTPS](#-konfigurasi-domain--https)
- [Auto-Start Setelah Reboot Server](#-auto-start-setelah-reboot-server)
- [Update Aplikasi](#-update-aplikasi-setelah-deploy-ke-vps)
- [Tutorial Instalasi Lengkap](#-tutorial-instalasi-lengkap)
- [Akun Akses Default](#-akun-akses-default)
- [Lisensi](#-lisensi)

---

## ✨ Fitur Utama

### 🌐 Otomasi & Manajemen Jaringan (Mikrotik Integration)
| Fitur | Deskripsi |
|---|---|
| **PPPoE & Hotspot Billing** | Manajemen pembuatan voucher Hotspot otomatis (harian, mingguan, bulanan) dan akun PPPoE terpadu langsung dari dasbor administrasi. |
| **Isolir Otomatis** | Penangguhan otomatis akses internet pelanggan saat masa aktif paket berakhir, lengkap dengan pengalihan (*routing redirection*) menuju halaman Isolir. |
| **Auto-Polling Realtime** | Sinkronisasi status pembayaran QRIS yang andal untuk pembukaan isolir instan tanpa campur tangan admin. |

### 👤 Portal Pelanggan Terpadu (Customer Self-Service)
| Fitur | Deskripsi |
|---|---|
| **Simulasi Cerdas** | Membantu calon pelanggan menemukan paket internet (Normal, Streaming, Gaming, Bisnis) sesuai kebutuhan perangkat. |
| **Cek Tagihan Mandiri** | Akses instan untuk memeriksa invoice dan melakukan pembayaran via QRIS Statis maupun Virtual Account. |
| **Asisten Obrolan AI** | Chatbot responsif yang disematkan langsung di portal pelanggan untuk bantuan instan 24/7. |

### 📱 Progressive Web App (PWA)
Mendukung instalasi mandiri (*standalone mode*) ke layar beranda perangkat mobile/desktop dengan branding sesuai peran pengguna:

| Peran | Nama Aplikasi |
|---|---|
| Pelanggan | **ZenRadius Client** |
| Administrator | **ZenRadius Admin** |
| Teknisi Lapangan | **ZenRadius Teknisi** |
| Reseller / Mitra | **ZenRadius Reseller** |
| Kolektor Keuangan | **ZenRadius Kolektor** |

Aset statis di-cache menggunakan strategi **Stale-While-Revalidate** untuk pengalaman akses yang instan tanpa jeda pembersihan berkas oleh pengguna akhir.

---

## 💳 Integrasi Payment Gateway

ZenRadius mendukung berbagai metode pembayaran otomatis untuk tagihan pelanggan maupun pembelian voucher publik — mulai dari payment gateway populer di Indonesia hingga QRIS Statis mandiri tanpa biaya transaksi tambahan.

### Payment Gateway Online (Otomatis Penuh)
| Gateway | Metode Didukung | Webhook Callback |
|---|---|---|
| **Tripay** | QRIS, Virtual Account (BCA/BNI/BRI/Permata/Mandiri), E-Wallet | `/customer/payment/callback` |
| **Midtrans (Snap)** | QRIS, Virtual Account, Kartu Kredit, E-Wallet | `/customer/payment/callback` |
| **Xendit** | QRIS, Virtual Account, Retail Outlet, E-Wallet | `/customer/payment/callback` |
| **Duitku** | QRIS, Virtual Account, E-Wallet | `/customer/payment/callback` |
| **iPaymu** | QRIS, DANA, ShopeePay, Virtual Account | `/customer/payment/callback` |
| **Digiflazz Payment** | QRIS, E-Money, Transfer Bank, Virtual Account | `/api/webhook/digiflazz-payment` |

Semua gateway di atas melakukan verifikasi **signature webhook** sebelum menandai tagihan/voucher sebagai lunas, serta otomatis memicu aktivasi ulang pelanggan yang sedang diisolir dan pengiriman notifikasi WhatsApp.

### QRIS Statis Mandiri (Semi-Otomatis, Tanpa Fee Gateway)
Selain payment gateway online, ZenRadius juga mendukung **QRIS Statis** dari akun e-wallet bisnis (mis. **DANA Bisnis**) yang di-upload/di-input langsung oleh admin — cocok untuk yang ingin menghindari biaya transaksi payment gateway pihak ketiga:

| Fitur | Deskripsi |
|---|---|
| **Kode Bayar Unik** | Setiap tagihan/voucher otomatis diberi nominal unik (+1–999 rupiah) agar pembayaran dapat dicocokkan otomatis tanpa perlu konfirmasi manual. |
| **QRIS Dinamis dari Payload Statis** | Jika payload QRIS statis diisi, sistem otomatis mengonversinya menjadi QRIS dinamis (nominal sudah terisi) saat pelanggan melakukan scan. |
| **Webhook DANA Bisnis** | Endpoint `/api/webhook/dana` menerima notifikasi pembayaran langsung dari dashboard DANA Bisnis — tanpa perlu aplikasi otomasi HP pihak ketiga (mis. MacroDroid). |
| **Webhook Generik (MacroDroid/SMS/dll)** | Endpoint `/api/webhook/v1/payment-notif` tersedia sebagai fallback untuk integrasi notifikasi lain (SMS banking, aplikasi otomasi HP) dengan proteksi `secret_key`. |
| **Monitoring Real-time** | Panel admin **Notifikasi E-Wallet** (`/admin/ewallet-logs`) menampilkan log seluruh notifikasi masuk (status parsing, nominal, invoice/voucher yang cocok, IP pengirim) dengan filter, live mode, dan notifikasi browser real-time. |

> 📄 Panduan detail setup DANA Bisnis: lihat `DANA_QRIS_INTEGRATION.md`. Panduan Digiflazz Payment Gateway: lihat `DIGIFLAZZ_PAYMENT_INTEGRATION.md`.

---

## 🛠 Tumpukan Teknologi

| Komponen | Teknologi |
|---|---|
| **Runtime** | Node.js v18+ |
| **Backend Framework** | Express.js |
| **Templating** | EJS |
| **Database** | SQLite 3 (`better-sqlite3`) |
| **UI Framework** | Bootstrap 5.3 + Bootstrap Icons |
| **PWA** | Service Worker + Web App Manifest |
| **Integrasi Jaringan** | Mikrotik RouterOS API |

---

## 💻 Persyaratan Sistem

| Kebutuhan | Spesifikasi |
|---|---|
| **Sistem Operasi** | Windows 10/11, Windows Server, atau Linux (Ubuntu/Debian) |
| **Runtime** | [Node.js](https://nodejs.org/) v18.x atau lebih baru (LTS direkomendasikan) |
| **Database** | SQLite 3 (via `better-sqlite3`) |
| **Reverse Proxy (Opsional)** | Nginx atau Apache (untuk SSL/HTTPS & sertifikat PWA) |
| **Hardware Minimum** | 1 vCPU, 1 GB RAM, 10 GB Storage |

---

## ⚡ Instalasi via install.sh (VPS/Production)

Cara resmi untuk deploy ZenRadius di VPS/server production adalah lewat `install.sh` yang tersedia di root repository. Skrip ini memasang seluruh kebutuhan sistem (Node.js, PM2, dan Nginx+Certbot bila diperlukan), memasang dependensi aplikasi, menyiapkan `.env`, memverifikasi database, lalu menjalankan aplikasi lewat **PM2** dengan auto-start saat reboot.

> `install.sh` tidak menjalankan `npm start`. Proses production sepenuhnya dikelola PM2 agar aplikasi otomatis restart saat crash atau server reboot.

### Langkah 1: Clone Repository
Bebas menentukan lokasi instalasi, disarankan di dalam `/opt`:
```bash
cd /opt
git clone https://github.com/zenradius/zenradius.git
cd zenradius
```

Jika ingin memisahkan beberapa aplikasi dalam satu server:
```bash
mkdir -p /opt/apps && cd /opt/apps
git clone https://github.com/zenradius/zenradius.git
cd zenradius
```

### Langkah 2: Jalankan Skrip Instalasi

**Mode Normal** — VPS belum punya reverse proxy, pakai Nginx + SSL otomatis:
```bash
chmod +x install.sh
sudo ./install.sh zenradius.net
```
Ganti `zenradius.net` dengan domain Anda. Jika argumen domain tidak disertakan, skrip akan menanyakan domain secara interaktif (bisa dikosongkan untuk mode tanpa domain/HTTPS).

**Mode Cloudflare Tunnel** — VPS sudah punya Cloudflare Tunnel + domain yang diarahkan ke tunnel tersebut:
```bash
chmod +x install.sh
sudo ./install.sh --cloudflare
```
Dalam mode ini, skrip tidak memasang atau menyentuh Nginx maupun Certbot sama sekali — domain dan HTTPS sepenuhnya menjadi tanggung jawab Cloudflare. Skrip hanya memastikan aplikasi berjalan di `localhost:<PORT>` agar bisa diteruskan oleh `cloudflared` yang sudah dikonfigurasi sebelumnya.

### Apa yang Dilakukan Skrip Ini
1. Validasi lingkungan — memastikan dijalankan dengan `sudo`, dari folder hasil clone repository yang benar, dan OS Ubuntu/Debian.
2. Domain wajib untuk mode normal — jika kosong, skrip meminta input interaktif; validasi format domain (menolak URL lengkap). Dilewati sepenuhnya pada mode `--cloudflare`.
3. Memasang Node.js 20 LTS, memperbarui npm ke versi **10.9.9** (npm 10.x selaras Node 20 LTS) bila diperlukan, lalu memasang build tools (`python3`, `make`, `g++`) dan PM2. Nginx & Certbot hanya dipasang pada mode normal.
4. Memasang dependensi aplikasi (`npm ci`/`npm install` mode production).
5. Menyiapkan `.env` dari `.env.example` jika belum ada — tidak menimpa `.env` yang sudah dikonfigurasi.
6. Menjalankan `scripts/verify-database.js`.
7. Konfigurasi Nginx + SSL otomatis (hanya mode normal, hanya jika domain diisi) — dilewati jika sudah ada dari instalasi sebelumnya.
8. Menjalankan aplikasi via PM2 (`pm2 start`/`pm2 reload`), lalu `pm2 save` + `pm2 startup` agar aplikasi otomatis hidup kembali saat VPS reboot.

> Pada mode Cloudflare, `install.sh` tidak memasang/mengonfigurasi `cloudflared` itu sendiri. Pastikan Cloudflare Tunnel sudah disiapkan lebih dulu dan diarahkan ke port aplikasi (`PORT` di `.env`, default `3001`).

### Aman Dijalankan Berulang Kali
Skrip ini tidak menimpa data yang sudah ada saat dijalankan ulang:
* `.env`, `database/`, `public/uploads/`, `auth_info_baileys/` (sesi WhatsApp) — dibiarkan apa adanya
* Konfigurasi Nginx & sertifikat SSL yang sudah ada — dilewati, tidak dibuat ulang
* Aplikasi yang sudah dikenal PM2 — di-reload, bukan dijalankan sebagai proses baru

> Update kode selanjutnya cukup dilakukan lewat menu **Update GitHub** di panel admin (`/admin/update`) — bukan menjalankan ulang `install.sh` maupun `git pull` manual tanpa restart PM2.

---

## 🐳 Menjalankan via Docker (Alternatif)

Selain instalasi manual di atas, ZenRadius juga sudah menyediakan `Dockerfile` dan `compose.yaml` sehingga Anda bisa menjalankan aplikasi tanpa perlu memasang Node.js secara langsung di server.

### Persyaratan
* [Docker Engine](https://docs.docker.com/engine/install/) v20+
* [Docker Compose](https://docs.docker.com/compose/install/) v2+ (biasanya sudah bundel dengan Docker Desktop / `docker compose` plugin)

### Langkah 1: Clone Repositori
```bash
git clone https://github.com/zenradius/zenradius.git
cd zenradius
```

### Langkah 2: Konfigurasi Environment
```bash
cp .env.example .env    # Linux/Mac
copy .env.example .env  # Windows CMD/PowerShell
```
Sesuaikan nilai `.env` sesuai kebutuhan (kredensial admin, secret webhook, port, dll). Pada `NODE_ENV=production` aplikasi **menolak start** jika `SESSION_SECRET` atau `SETTINGS_MASTER_KEY` masih kosong/placeholder — isi keduanya dengan string acak yang panjang.

Buat juga `settings.json` awal **sebelum** container dijalankan (nilai lain diisi otomatis oleh aplikasi saat start). `compose.yaml` me-mount berkas ini secara bind; jika berkas belum ada, Docker akan membuat **direktori** kosong bernama `settings.json` dan aplikasi gagal membaca konfigurasi:
```bash
echo '{"server_port": 3001}' > settings.json                    # Linux/Mac
Set-Content settings.json '{"server_port": 3001}' -Encoding ascii  # Windows PowerShell
```
Nilai `server_port` harus sama dengan `PORT` di `.env` dan port yang dipublikasikan di `compose.yaml`.

### Langkah 3: Build & Jalankan Container
```bash
docker compose up -d --build
```
Perintah ini akan:
* Build image dari `Dockerfile` (Node.js 20 + npm 10.x + dependency native seperti `better-sqlite3`)
* Menjalankan container `zenradius-app` di background (`-d`)
* Mem-bind port `127.0.0.1:3001` ke container (gunakan reverse proxy Nginx/Apache untuk expose ke publik dengan HTTPS)
* Mount volume persisten: `settings.json`, `database/`, `data/`, `public/uploads/`, `auth_info_baileys/` — sehingga data **tidak hilang** saat container di-rebuild
* Menjalankan **health check** otomatis ke endpoint `/health` setiap 30 detik

### Langkah 4: Verifikasi Container Berjalan
```bash
docker compose ps
docker compose logs -f zenradius
```
Aplikasi dapat diakses melalui **`https://yourdomain.com`** (setelah dikonfigurasi reverse proxy) atau `http://127.0.0.1:3001` secara lokal di server.

### Perintah Operasional Umum
| Aksi | Perintah |
|---|---|
| Hentikan container | `docker compose down` |
| Restart container | `docker compose restart zenradius` |
| Lihat log real-time | `docker compose logs -f zenradius` |
| Masuk ke shell container | `docker compose exec zenradius sh` |
| Update ke versi terbaru | `git pull && docker compose up -d --build` |

> 💡 **Tip:** Jika menggunakan fitur **Update GitHub** di panel admin saat berjalan via Docker, pastikan container memiliki akses `git` dan proses restart dilakukan melalui `docker compose restart zenradius` (bukan PM2), karena aplikasi di dalam container tidak dikelola oleh PM2.

---

## 🌐 Konfigurasi Domain & HTTPS

Secara default aplikasi hanya berjalan di `127.0.0.1:3001` (baik mode manual maupun Docker) — **belum otomatis** dapat diakses via domain custom. Diperlukan **reverse proxy + SSL** agar aplikasi bisa diakses publik melalui `https://yourdomain.com` dan agar fitur PWA (install ke home screen) dapat berfungsi (PWA mewajibkan HTTPS).

```mermaid
flowchart LR
    A[🌐 Domain] -->|DNS A Record| B[VPS Public IP]
    B --> C[Nginx :80 / :443]
    C -->|proxy_pass| D[Node.js App :3001]
    C -->|SSL Certbot| E[HTTPS Aktif]
```

### 1️⃣ Arahkan Domain ke VPS (DNS)
Di panel DNS domain Anda (Cloudflare, Niagahoster, dll), buat record:
```
Type: A
Name: @ (atau subdomain, misal: app)
Value: <IP_Publik_VPS_Anda>
```

### 2️⃣ Pasang & Konfigurasi Nginx (Reverse Proxy)
```bash
sudo apt update && sudo apt install nginx -y
```

Buat berkas konfigurasi baru `/etc/nginx/sites-available/zenradius`:
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Aktifkan konfigurasi:
```bash
sudo ln -s /etc/nginx/sites-available/zenradius /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3️⃣ Aktifkan HTTPS (SSL Gratis via Let's Encrypt)
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```
Certbot otomatis memperbarui konfigurasi Nginx untuk HTTPS dan mengelola **auto-renewal** sertifikat setiap ± 60 hari.

### 4️⃣ Perbarui Variabel Environment
Pastikan nilai terkait URL aplikasi pada `.env` menggunakan domain HTTPS final, misalnya:
```dotenv
APP_URL=https://yourdomain.com
```

> ✅ **Setelah setup ini dilakukan satu kali**, domain akan otomatis tetap berfungsi setiap kali VPS/container restart — Nginx dan sertifikat SSL berjalan sebagai service permanen di VPS, tidak perlu diulang manual.

---

## 🔁 Auto-Start Setelah Reboot Server

Agar aplikasi **otomatis kembali berjalan** saat VPS mati listrik/direstart, konfigurasi berikut wajib disiapkan sesuai metode deploy yang digunakan.

| Metode Deploy | Otomatis Jalan Saat Server Reboot? |
|---|---|
| **Docker Compose** (`restart: unless-stopped`) | ✅ Ya, otomatis (asalkan Docker service ter-enable) |
| **`install.sh`** (PM2 dikonfigurasi otomatis) | ✅ Ya, otomatis — tidak perlu setup tambahan |
| **Manual (`npm start`, tanpa PM2)** | ❌ Tidak — aplikasi mati total, perlu start manual |

### 🐳 Opsi A: Docker Compose (Direkomendasikan)
`compose.yaml` sudah dikonfigurasi dengan `restart: unless-stopped`, sehingga container otomatis restart saat crash maupun saat server reboot — asalkan **Docker daemon** sendiri otomatis aktif saat boot:
```bash
sudo systemctl is-enabled docker
# jika hasilnya belum "enabled":
sudo systemctl enable docker
```
Tidak ada langkah tambahan lain — setelah ini, aplikasi akan otomatis hidup kembali tanpa intervensi manual.

### ⚙️ Opsi B: `install.sh` (Sudah Otomatis)
Jika Anda men-deploy menggunakan `install.sh` (lihat bagian [Instalasi Otomatis via Skrip](#-instalasi-otomatis-via-skrip-vpsproduction)), **PM2 sudah otomatis dikonfigurasi** untuk auto-start saat reboot — tidak ada langkah tambahan yang perlu dilakukan.

Jika Anda menjalankan aplikasi secara manual di luar `install.sh` (langsung `node app-customer.js`), pasang PM2 sendiri:
```bash
npm install -g pm2
pm2 start app-customer.js --name zenradius
pm2 save
pm2 startup
```
Perintah `pm2 startup` akan menampilkan satu baris perintah `sudo` — jalankan perintah tersebut satu kali untuk mendaftarkan PM2 sebagai service sistem (systemd).

### ✅ Verifikasi
Uji dengan me-reboot server:
```bash
sudo reboot
```
Setelah server kembali online, cek status:
```bash
# Docker
docker compose ps

# PM2
pm2 list
```
Aplikasi seharusnya berstatus **running** tanpa perlu login/start ulang secara manual.

---

## 🔄 Update Aplikasi (Setelah Deploy ke VPS)

ZenRadius memiliki fitur **Update GitHub** bawaan di panel admin, sehingga Anda **tidak perlu SSH manual** setiap kali ada perubahan kode. Alurnya:

```mermaid
flowchart LR
    A[💻 Edit Kode di Lokal] --> B[git push ke GitHub]
    B --> C[🖥️ VPS: Buka Menu Admin ➡ Update GitHub]
    C --> D[Klik 'Cek Versi']
    D --> E[Klik 'Update Sekarang']
    E --> F[Klik 'Restart Aplikasi']
    F --> G[✅ Aplikasi VPS Ter-update]
```

### Syarat Awal di VPS (Sekali Setup)
Pastikan aplikasi di VPS berjalan dari hasil `git clone`, **bukan** hasil upload manual/zip:
```bash
cd /path/to/zenradius
git remote -v   # pastikan menunjuk ke https://github.com/zenradius/zenradius.git
```
Jika belum, clone ulang dan pindahkan folder `database/`, `.env`, `public/uploads`, serta `auth_info_baileys` (sesi WhatsApp) ke lokasi hasil clone.

### Langkah Update via Panel Admin
1. **Di lokal:** selesaikan perubahan, lalu jalankan:
   ```bash
   git add .
   git commit -m "deskripsi perubahan"
   git push
   ```
2. **Login ke Panel Admin VPS** → buka menu **☁️ Update GitHub** (`/admin/update`).
3. Klik **Cek Versi** — sistem akan membandingkan `version.txt` lokal VPS dengan `origin/<branch>` di GitHub.
4. Jika status menunjukkan **"Ada update"**, klik **Update Sekarang**.
   * Sistem otomatis **backup** file penting (`settings.json`, `.env`, `database/`, `public/uploads`, `public/img`, `data`, sesi WhatsApp) sebelum menarik kode terbaru.
   * Kode ditarik via `git reset --hard origin/<branch>`, lalu file yang di-backup dikembalikan.
   * Jika `package.json` berubah, `npm install` otomatis dijalankan.
5. Setelah proses selesai, klik **Restart Aplikasi** agar perubahan diterapkan (proses PM2/Node di-restart otomatis oleh sistem).

> 💡 **Tip:** Gunakan bagian **Official Release Channel** di halaman yang sama jika ingin proses update yang lebih ketat (verifikasi checksum/signature rilis resmi) dengan restart otomatis + health check pasca-update.

> ⚠️ **Catatan:** Pastikan koneksi internet VPS stabil selama proses update berlangsung, dan hindari menutup halaman sebelum status menunjukkan selesai.

---

## 📘 Tutorial Instalasi Lengkap

Panduan lengkap untuk pengguna yang ingin memasang ZenRadius di VPS dan menyiapkannya untuk production tersedia di:

### 👉 [tutorial.zenradius.net](https://tutorial.zenradius.net)

Tutorial mencakup persiapan server, instalasi via `install.sh`, Docker Compose, konfigurasi domain dan HTTPS, Cloudflare Tunnel, MikroTik, RADIUS, ACS TR-069, WhatsApp, payment gateway, backup, keamanan, troubleshooting, dan checklist go-live.

> Disarankan mengikuti tutorial secara berurutan dari persiapan server hingga checklist go-live.

---

## 🔐 Akun Akses Default

Gunakan kredensial berikut untuk login pertama kali ke **Pusat Administrasi ZenRadius**:

| Item | Nilai |
|---|---|
| **URL Login** | `https://yourdomain.com/admin/login` |
| **Username** | `zenradius` |
| **Password** | `zenradius123` |

> ⚠️ **Penting:** Segera ubah kredensial default ini melalui menu pengaturan dasbor admin setelah berhasil masuk, demi keamanan basis data dan router Mikrotik Anda.

---

## 📝 Lisensi & Model Pembelian

ZenRadius adalah produk berbayar berlisensi proprietari menggunakan model pembelian **Aktivasi Lisensi Sekali Bayar untuk Selamanya (Lifetime License)**. 

### Ketentuan Lisensi:
1. **Satu Lisensi per Domain**: Pembelian lisensi diikat secara ketat pada satu host kustom / FQDN (misalnya: `billing.ispanda.net`).
2. **Aktif Selamanya (Lifetime)**: Tidak ada biaya bulanan, tidak ada tarif berlangganan tahunan, dan tidak ada biaya tersembunyi. Sekali diaktifkan, lisensi valid selamanya.
3. **Pembaruan Berkelanjutan Gratis**: Tetap mendapatkan akses pembaruan fitur (update via git), tambalan sistem keamanan, serta perbaikan bug tanpa perlu membayar ekstra.
4. **Masa Tenggang Integratif (Grace Period)**: Instalasi baru ZenRadius tanpa kunci serial valid akan memasuki *masa tenggang selama 7 hari* dengan fungsionalitas penuh. Setelah masa tenggang berakhir, sistem akan mengunci akses ke panel admin secara otomatis sampai serial yang sah selesai diaktivasi.

### 💰 Informasi Harga dan Pemesanan:
*   **Investasi**: **Rp 300.000 / Domain** (Lisensi Premium Aktif Selamanya)
*   **Cara Pemesanan**: Klik tombol **Order Lisensi** langsung dari halaman Pengaturan admin ZenRadius Anda, atau hubungi Developer resmi via WhatsApp di **+62 851-7800-8881**.

---

Hak Cipta © 2026 ZenRadius — All Rights Reserved.

<div align="center">

**Ditenagai oleh ZenRadius — All Rights Reserved**

</div>
