# ZenRadius — One Platform for Your Network 🚀

ZenRadius adalah platform manajemen billing ISP, otomasi jaringan Mikrotik, billing Hotspot/PPPoE, dan portal mandiri pelanggan (*Customer Self-Service*) yang dirancang secara modern, responsif, dan siap digunakan (*production-ready*) sebagai aplikasi web berbasis PWA (*Progressive Web App*).

---

## 📌 Fitur Utama & Spesifikasi Aplikasi

### 1. Otomasi & Manajemen Jaringan (Mikrotik Integration)
* **PPPoE & Hotspot Billing:** Manajemen pembuatan voucher Hotspot otomatis (harian, mingguan, bulanan) dan akun PPPoE terpadu langsung dari dasbor administrasi.
* **Isolir Otomatis (Auto Isolate):** Penangguhan otomatis akses internet pelanggan jika masa aktif paket berakhir, lengkap dengan pengalihan otomatis (*routing redirection*) menuju halaman Isolir.
* **Auto-Polling Realtime:** Sinkronisasi status pembayaran QRIS yang andal untuk pembukaan isolir instan tanpa campur tangan admin.

### 2. Portal Pelanggan Terpadu & Fitur Cerdas (Customer Self-Service)
* **Simulasi Cerdas:** Membantu calon pelanggan menemukan paket internet (NORMAL, STREAMING, GAMING, BISNIS) yang sesuai kebutuhan perangkat mereka.
* **Cek Tagihan Mandiri:** Akses instan bagi pelanggan untuk memeriksa laporan invoice dan melakukan pembayaran QRIS Statis maupun Virtual Account secara praktis.
* **Dukungan Asisten Obrolan AI:** Chatbot responsif yang disematkan langsung di portal pelanggan untuk bantuan instan 24/7.

### 3. Progressive Web App (PWA) Support
* **Multi-Role Apps:** Mendukung instalasi mandiri (*standalone mode*) pada layar beranda gawai mobile/desktop dengan nama dinamis sesuai peran pengguna:
  * Pelanggan ➡️ **ZenRadius Client**
  * Administrator ➡️ **ZenRadius Admin**
  * Teknisi Lapangan ➡️ **ZenRadius Teknisi**
  * Reseller/Mitra ➡️ **ZenRadius Reseller**
  * Kolektor Keuangan ➡️ **ZenRadius Kolektor**
* **Stale-While-Revalidate Caching:** Akses muat aset statis, CSS, dan brand logo instan tanpa jeda pembersihan berkas oleh pengguna akhir.

---

## 💻 Spesifikasi & Persyaratan Sistem

Pastikan lingkungan server Anda telah memenuhi spesifikasi di bawah ini sebelum memulai proses instalasi:

* **Sistem Operasi:** Windows 10/11, Windows Server, atau Linux (Ubuntu/Debian)
* **Runtime Environment:** [Node.js](https://nodejs.org/) versi v18.x atau yang lebih baru (Sangat direkomendasikan versi LTS terbaru)
* **Database Engine:** SQLite 3 (Ditenagai oleh library super cepat `better-sqlite3`)
* **Web Server Proxy (Opsional untuk Production):** Nginx atau Apache (untuk SSL/HTTPS reverse proxy sertifikat PWA)
* **Hardware Spesifikasi Minimum:** 1 Core CPU, 1 GB RAM, 10 GB Storage Disk

---

## 📥 Panduan Langkah Instalasi & Pengaktifan

Ikuti langkah-langkah di bawah ini untuk memasang dan menjalankan ZenRadius di lingkungan server lokal Anda:

### Langkah 1: Unduh / Clone Projek dari GitHub
Jika Git sudah terpasang, jalankan perintah ini di Terminal:
```bash
git clone https://github.com/zenradius/zenradius.git
cd zenradius
```

### Langkah 2: Memasang Dependensi Proyek
Pasang modul paket Node.js yang diperlukan proyek menggunakan npm:
```bash
npm install
```

### Langkah 3: Konfigurasi Environment (`.env`)
Salin file `.env.example` ke dalam format berkas baru bernama `.env` dan sesuaikan nilainya:
```ini
# Salin konfigurasi environment
cp .env.example .env   # untuk Linux/Mac
copy .env.example .env # untuk Windows CMD/Powershell
```

Isi berkas `.env` dengan kredensial aman Anda:
```dotenv
MASTER_ADMIN_USERNAME=zenradius
MASTER_ADMIN_PASSWORD=zenradius123
MY_WEBHOOK_SECRET=Qris-Statik-key
PORT=3001
```

### Langkah 4: Sinkronisasi dan Verifikasi Database
Jalankan skrip pemeriksaan struktur SQLite untuk memastikan seluruh tabel dan kolom database esensial telah terbuat dengan sempurna:
```bash
node scripts/verify-database.js
```

### Langkah 5: Menjalankan Aplikasi
* **Mode Development (Hot-Reloading):**
  ```bash
  npm run dev
  ```
* **Mode Production:**
  ```bash
  npm start
  ```

Aplikasi ZenRadius sekarang sudah dapat diakses di browser melalui alamat URL: **`http://localhost:3001`** atau port kustom yang telah Anda tentukan.

---

## 🔐 Akun Akses Default Admin

Untuk pertama kali login masuk ke **Pusat Administrasi ZenRadius** (`http://localhost:3001/admin/login`), gunakan kredensial bawaan berikut:

* **Alamat Halaman Login:** `http://localhost:3001/admin/login`
* **Username Default:** `zenradius`
* **Password Default:** `zenradius123`

> ⚠️ **PENTING:** Segera ubah kredensial default ini pada menu pengaturan dasbor admin setelah Anda berhasil masuk ke dalam sistem demi mengamankan basis data dan routers Mikrotik Anda!

---

## 📝 Lisensi
Diterbitkan di bawah lisensi resmi proprietari ZenRadius. Hak Cipta dilindungi Undang-Undang.
Ditenagai oleh **ZenRadius - All Rights Reserved**.
