#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# ZenRadius — Skrip Instalasi & Deploy Production (VPS)
# ═══════════════════════════════════════════════════════════════════════════
# Dijalankan SETELAH repository di-clone secara manual oleh user ke lokasi
# pilihannya sendiri (mis. /opt/zenradius atau /opt/apps/zenradius).
#
#   cd /opt/apps
#   git clone https://github.com/zenradius/zenradius.git
#   cd zenradius
#   chmod +x install.sh
#   sudo ./install.sh zenradius.net      # mode normal: Nginx + SSL (Certbot)
#   sudo ./install.sh --cloudflare        # mode Cloudflare Tunnel (skip Nginx/SSL)
#
# Mode --cloudflare digunakan jika VPS SUDAH memiliki Cloudflare Tunnel yang
# terpasang dan domain yang sudah diarahkan ke tunnel tersebut. Dalam mode
# ini, skrip TIDAK memasang/menyentuh Nginx maupun Certbot sama sekali —
# domain & HTTPS sepenuhnya menjadi tanggung jawab Cloudflare. Skrip hanya
# perlu memastikan aplikasi berjalan di localhost:<PORT> agar bisa diteruskan
# oleh cloudflared.
#
# Skrip ini TIDAK menjalankan "npm start" — proses production sepenuhnya
# dikelola oleh PM2. "npm start" / "npm run dev" tetap tersedia terpisah
# khusus untuk kebutuhan development di komputer lokal.
#
# Skrip ini AMAN dijalankan berulang kali (idempotent):
#   - Tidak menimpa .env, database/, public/uploads/, auth_info_baileys/
#   - Tidak meminta ulang sertifikat SSL jika sudah terpasang
#   - Reload PM2 (bukan start baru) jika aplikasi sudah berjalan
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="zenradius"
APP_ENTRY="app-customer.js"
USE_CLOUDFLARE=false
DOMAIN=""

# ── Parsing Argumen: --cloudflare atau domain biasa ─────────────────────
for arg in "$@"; do
  case "$arg" in
    --cloudflare) USE_CLOUDFLARE=true ;;
    --*) ;; # abaikan flag tak dikenal agar tidak dianggap domain
    *) DOMAIN="$arg" ;;
  esac
done

info()  { echo -e "\033[1;36m[INFO]\033[0m $1"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m $1"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m $1"; }
fail()  { echo -e "\033[1;31m[GAGAL]\033[0m $1"; exit 1; }

cd "$APP_DIR"

# ── 0. Validasi Dasar ────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  fail "Skrip ini perlu dijalankan dengan sudo/root: sudo ./install.sh <domain>"
fi

if [ ! -f "$APP_ENTRY" ] || [ ! -f "package.json" ]; then
  fail "File aplikasi tidak ditemukan di folder ini. Pastikan Anda menjalankan skrip dari dalam folder hasil git clone repository ZenRadius."
fi

if [ -f /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) : ;;
    *) warn "Sistem operasi terdeteksi: ${PRETTY_NAME:-tidak diketahui}. Skrip ini dioptimalkan untuk Ubuntu/Debian — lanjut dengan risiko sendiri." ;;
  esac
else
  warn "Tidak dapat mendeteksi distribusi OS. Melanjutkan proses instalasi..."
fi

# ── 1. Domain: Wajib untuk Production (dilewati pada mode --cloudflare) ──
if [ "$USE_CLOUDFLARE" = true ]; then
  info "Mode Cloudflare Tunnel aktif — konfigurasi Nginx & SSL akan dilewati sepenuhnya."
  info "Pastikan cloudflared di VPS ini sudah diarahkan ke http://localhost:<PORT> aplikasi."
else
  if [ -z "$DOMAIN" ]; then
    read -rp "Masukkan domain untuk aplikasi ini (contoh: zenradius.net), atau kosongkan untuk mode tanpa domain: " DOMAIN
  fi
  if [ -n "$DOMAIN" ]; then
    if [[ "$DOMAIN" =~ ^https?:// ]] || [[ "$DOMAIN" == */* ]]; then
      fail "Domain tidak valid: '$DOMAIN'. Masukkan nama domain saja, contoh: zenradius.net (tanpa https:// atau path)."
    fi
    info "Domain production: $DOMAIN"
  else
    warn "Domain tidak diisi — instalasi akan lanjut TANPA konfigurasi Nginx/SSL. Aplikasi hanya bisa diakses via http://<IP-VPS>:3001."
  fi
fi

# ── 2. Pasang Kebutuhan Sistem (git, Node.js, Nginx, Certbot, PM2) ──────
apt_install_if_missing() {
  local bin="$1"; shift
  local pkgs=("$@")
  if ! command -v "$bin" >/dev/null 2>&1; then
    info "Memasang: ${pkgs[*]} ..."
    apt-get update -qq
    apt-get install -y "${pkgs[@]}"
  else
    ok "$bin sudah terpasang."
  fi
}

apt_install_if_missing git git
if ! command -v node >/dev/null 2>&1; then
  info "Node.js belum terpasang. Memasang Node.js 20.x LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  ok "Node.js sudah terpasang ($(node -v))."
fi
command -v npm >/dev/null 2>&1 || fail "npm tidak ditemukan meskipun Node.js sudah terpasang."

if ! command -v pm2 >/dev/null 2>&1; then
  info "Memasang PM2 secara global..."
  npm install -g pm2
else
  ok "PM2 sudah terpasang."
fi

if [ "$USE_CLOUDFLARE" = false ] && [ -n "$DOMAIN" ]; then
  apt_install_if_missing nginx nginx
  if ! command -v certbot >/dev/null 2>&1; then
    apt_install_if_missing certbot certbot python3-certbot-nginx
  else
    ok "Certbot sudah terpasang."
  fi
fi

# ── 3. Dependensi Aplikasi (Node.js) ────────────────────────────────────
info "Memasang dependensi Node.js (production)..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "Dependensi terpasang."

# ── 4. Environment (.env) — Tidak Menimpa yang Sudah Ada ────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn "File .env dibuat dari .env.example. SEGERA edit kredensial di .env sebelum digunakan produksi!"
  else
    warn ".env.example tidak ditemukan — buat .env secara manual sebelum menjalankan aplikasi."
  fi
else
  ok "File .env sudah ada, tidak diubah."
fi

# ── 5. Verifikasi Database ──────────────────────────────────────────────
if [ -f scripts/verify-database.js ]; then
  info "Menjalankan verifikasi struktur database..."
  node scripts/verify-database.js || warn "Verifikasi database menampilkan peringatan — periksa log di atas."
fi

# ── 6. Konfigurasi Nginx + SSL (dilewati pada mode --cloudflare) ────────
if [ "$USE_CLOUDFLARE" = true ]; then
  info "Mode Cloudflare Tunnel: konfigurasi Nginx & SSL dilewati sepenuhnya."
elif [ -n "$DOMAIN" ]; then
  NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}"
  if [ ! -f "$NGINX_CONF" ]; then
    info "Membuat konfigurasi Nginx untuk domain: $DOMAIN"
    cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
    ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${APP_NAME}"
    nginx -t && systemctl reload nginx
    ok "Konfigurasi Nginx dibuat & diaktifkan untuk $DOMAIN."
  else
    ok "Konfigurasi Nginx untuk $DOMAIN sudah ada — tidak diubah."
  fi

  # Cek apakah sertifikat SSL sudah ada sebelum minta baru
  if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
    ok "Sertifikat SSL untuk $DOMAIN sudah terpasang — dilewati."
  else
    info "Meminta sertifikat SSL via Certbot untuk $DOMAIN..."
    certbot --nginx -d "$DOMAIN" -d "www.${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect \
      || warn "Certbot gagal berjalan otomatis. Jalankan manual: certbot --nginx -d $DOMAIN"
  fi
fi

# ── 7. Jalankan Aplikasi via PM2 (BUKAN npm start) ──────────────────────
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  info "Aplikasi sudah dikenal PM2. Menjalankan reload..."
  pm2 reload "$APP_NAME"
  ok "Aplikasi '$APP_NAME' berhasil di-reload."
else
  info "Menjalankan aplikasi pertama kali via PM2..."
  pm2 start "$APP_ENTRY" --name "$APP_NAME"
  ok "Aplikasi '$APP_NAME' berhasil dijalankan."
fi

pm2 save
info "Mendaftarkan PM2 agar auto-start saat server reboot..."
STARTUP_CMD="$(pm2 startup systemd -u "${SUDO_USER:-root}" --hp "$(eval echo ~"${SUDO_USER:-root}")" 2>/dev/null | grep -E '^sudo ' || true)"
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD"
  ok "PM2 terdaftar sebagai service sistem (auto-start saat reboot)."
else
  warn "Tidak dapat mendeteksi perintah pm2 startup otomatis. Jalankan 'pm2 startup' secara manual jika auto-start belum aktif."
fi

# ── 8. Ringkasan ─────────────────────────────────────────────────────────
APP_PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
APP_PORT="${APP_PORT:-3001}"

echo ""
ok "═══════════════════════════════════════════════════════════════"
ok " Instalasi ZenRadius selesai!"
ok " Direktori aplikasi : $APP_DIR"
if [ "$USE_CLOUDFLARE" = true ]; then
  ok " Mode               : Cloudflare Tunnel"
  ok " URL akses          : sesuai domain yang dikonfigurasi di Cloudflare Tunnel Anda"
  warn " Pastikan cloudflared di VPS ini sudah diarahkan ke: http://localhost:${APP_PORT}"
elif [ -n "$DOMAIN" ]; then
  ok " URL akses          : https://${DOMAIN}"
else
  ok " URL akses          : http://<IP-VPS-ANDA>:${APP_PORT}"
fi
ok " Cek status PM2     : pm2 list"
ok " Lihat log aplikasi : pm2 logs $APP_NAME"
ok " Update kode        : gunakan menu 'Update GitHub' di panel admin"
ok "                      (jangan git pull manual tanpa restart PM2)"
ok "═══════════════════════════════════════════════════════════════"
