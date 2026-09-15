#!/usr/bin/env bash
# Skrip deploy production ZenRadius untuk VPS.
# Dijalankan dari dalam folder hasil git clone repo ini.
#
#   cd /opt/apps
#   git clone https://github.com/zenradius/zenradius.git
#   cd zenradius
#   chmod +x install.sh
#   sudo ./install.sh zenradius.net    # Nginx + SSL (Certbot)
#   sudo ./install.sh --cloudflare     # sudah pakai Cloudflare Tunnel
#
# Mode --cloudflare dipakai kalau VPS sudah punya Cloudflare Tunnel dan
# domain yang diarahkan ke tunnel tersebut. Nginx & Certbot tidak disentuh
# sama sekali di mode ini, cukup pastikan tunnel diarahkan ke localhost:<PORT>.
#
# Production selalu dijalankan lewat PM2, bukan npm start. npm start/npm run
# dev tetap ada untuk development lokal.
#
# Aman dijalankan berulang kali: tidak menimpa .env, database, uploads,
# sesi WhatsApp, atau sertifikat SSL yang sudah ada.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="zenradius"
APP_ENTRY="app-customer.js"
USE_CLOUDFLARE=false
DOMAIN=""

# Parsing argumen: --cloudflare atau domain
for arg in "$@"; do
  case "$arg" in
    --cloudflare) USE_CLOUDFLARE=true ;;
    --*) ;;
    *) DOMAIN="$arg" ;;
  esac
done

info()  { echo -e "\033[1;36m[INFO]\033[0m $1"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m $1"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m $1"; }
fail()  { echo -e "\033[1;31m[GAGAL]\033[0m $1"; exit 1; }

cd "$APP_DIR"

# Validasi dasar
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

# Domain wajib untuk mode normal, dilewati di mode --cloudflare
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

# Pasang kebutuhan sistem: git, Node.js, Nginx, Certbot, PM2
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
apt_install_if_missing curl curl ca-certificates
if ! command -v node >/dev/null 2>&1; then
  info "Node.js belum terpasang. Memasang Node.js 20.x LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  ok "Node.js sudah terpasang ($(node -v))."
fi
command -v npm >/dev/null 2>&1 || fail "npm tidak ditemukan meskipun Node.js sudah terpasang."

# Gunakan npm minimum 12.0.2 agar installer selalu memakai versi tooling yang konsisten.
# Node.js 20 tetap dipertahankan; npm 12 membutuhkan Node.js >=20.17.0.
NPM_TARGET_VERSION="12.0.2"
NPM_CURRENT_VERSION="$(npm --version)"
if [ "$(printf '%s\n' "$NPM_TARGET_VERSION" "$NPM_CURRENT_VERSION" | sort -V | head -n1)" != "$NPM_TARGET_VERSION" ]; then
  info "Memperbarui npm dari v${NPM_CURRENT_VERSION} ke v${NPM_TARGET_VERSION}..."
  npm install --global "npm@${NPM_TARGET_VERSION}"
  ok "npm siap digunakan ($(npm --version))."
else
  ok "npm sudah memenuhi versi minimum ($(npm --version))."
fi

# better-sqlite3 perlu dikompilasi dari source kalau tidak ada prebuilt
# binary untuk kombinasi Node.js/OS ini, jadi build tools wajib ada.
if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
  info "Memasang build tools (python3, make, g++) untuk kompilasi native addon..."
  apt-get update -qq
  apt-get install -y python3 make g++
else
  ok "Build tools (make, g++) sudah tersedia."
fi

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

# Dependensi aplikasi
info "Memasang dependensi Node.js (production)..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "Dependensi terpasang."

# Environment (.env) — tidak menimpa yang sudah ada
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    ok "File .env dibuat dari .env.example."
  else
    warn ".env.example tidak ditemukan — buat .env secara manual sebelum menjalankan aplikasi."
  fi
else
  ok "File .env sudah ada, tidak diubah."
fi

# Isi otomatis secret yang masih kosong/placeholder. Nilai yang sudah diisi
# tidak pernah ditimpa. NODE_ENV=production menolak start bila SESSION_SECRET
# masih placeholder, jadi ini wajib untuk instalasi baru.
gen_secret() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
ensure_env_secret() {
  local key="$1" placeholder_regex="$2"
  local current
  current="$(grep -E "^${key}=" .env 2>/dev/null | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
  if [ -z "$current" ] || [[ "$current" =~ $placeholder_regex ]]; then
    local value; value="$(gen_secret)"
    if grep -qE "^${key}=" .env 2>/dev/null; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      printf '\n%s=%s\n' "$key" "$value" >> .env
    fi
    ok "$key dibuat otomatis (acak)."
  fi
}
if [ -f .env ]; then
  ensure_env_secret SESSION_SECRET '^(ganti|change|secret|default|example)'
  ensure_env_secret MY_WEBHOOK_SECRET '^(ganti|change|secret|default|example)'
  ensure_env_secret SETTINGS_MASTER_KEY '^(ganti|change|secret|default|example)'
  chmod 600 .env
fi

# Folder runtime yang tidak ikut ter-clone dari git (lihat .gitignore) tapi
# wajib ada sebelum aplikasi/skrip database dijalankan.
mkdir -p database data logs backups public/uploads auth_info_baileys
ok "Folder runtime (database, data, logs, backups, public/uploads, auth_info_baileys) siap."

# Port aplikasi: diambil dari PORT di .env (default 3001) dan dipakai konsisten
# untuk settings.json (server_port) serta Nginx. Aplikasi membaca port dari
# settings.json, BUKAN dari .env, jadi keduanya harus sinkron.
APP_PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
APP_PORT="${APP_PORT:-3001}"
[[ "$APP_PORT" =~ ^[0-9]+$ ]] || fail "Nilai PORT di .env tidak valid: '$APP_PORT'"

if [ ! -f settings.json ]; then
  echo "{\"server_port\": ${APP_PORT}}" > settings.json
  ok "settings.json awal dibuat dengan server_port=${APP_PORT} (sisanya diisi default oleh aplikasi saat start)."
else
  ok "settings.json sudah ada, tidak diubah."
  SETTINGS_PORT="$(node -e "try{const s=require('./settings.json');console.log(s.server_port??'')}catch(e){console.log('')}" 2>/dev/null || true)"
  if [ -n "$SETTINGS_PORT" ] && [ "$SETTINGS_PORT" != "$APP_PORT" ]; then
    warn "server_port di settings.json (${SETTINGS_PORT}) berbeda dengan PORT di .env (${APP_PORT}). Nginx akan diarahkan ke ${SETTINGS_PORT}."
    APP_PORT="$SETTINGS_PORT"
  fi
fi

# Skema tabel dibuat oleh config/database.js saat pertama kali di-require,
# bukan oleh scripts/verify-database.js. Untuk instalasi baru (database masih
# kosong), skema perlu dibuat dulu sebelum verifikasi kolom dijalankan.
info "Menyiapkan skema database (jika belum ada)..."
node -e "require('./config/database')" || warn "Gagal menyiapkan skema awal database — periksa log di atas."

# Verifikasi database
if [ -f scripts/verify-database.js ]; then
  info "Menjalankan verifikasi struktur database..."
  node scripts/verify-database.js || warn "Verifikasi database menampilkan peringatan — periksa log di atas."
fi

# Konfigurasi Nginx + SSL — dilewati di mode --cloudflare
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
        proxy_pass http://127.0.0.1:${APP_PORT};
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

  # Sudah ada sertifikat? lewati, jangan minta ulang
  if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
    ok "Sertifikat SSL untuk $DOMAIN sudah terpasang — dilewati."
  else
    info "Meminta sertifikat SSL via Certbot untuk $DOMAIN..."
    certbot --nginx -d "$DOMAIN" -d "www.${DOMAIN}" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect \
      || warn "Certbot gagal berjalan otomatis. Jalankan manual: certbot --nginx -d $DOMAIN"
  fi
fi

# Jalankan aplikasi via PM2, bukan npm start
export NODE_ENV=production
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  info "Aplikasi sudah dikenal PM2. Menjalankan reload..."
  pm2 reload "$APP_NAME" --update-env
  ok "Aplikasi '$APP_NAME' berhasil di-reload."
else
  info "Menjalankan aplikasi pertama kali via PM2..."
  pm2 start "$APP_ENTRY" --name "$APP_NAME" --cwd "$APP_DIR" --time
  ok "Aplikasi '$APP_NAME' berhasil dijalankan."
fi

pm2 save
info "Mendaftarkan PM2 agar auto-start saat server reboot..."
STARTUP_OUTPUT="$(pm2 startup systemd -u root --hp /root 2>&1 || true)"
STARTUP_CMD="$(echo "$STARTUP_OUTPUT" | grep -E '^(sudo )?env PATH=' | head -n1)"
if [ -n "$STARTUP_CMD" ]; then
  eval "${STARTUP_CMD#sudo }"
  pm2 save
  ok "PM2 terdaftar sebagai service sistem (auto-start saat reboot)."
elif systemctl is-enabled pm2-root >/dev/null 2>&1; then
  ok "Service PM2 sudah terdaftar sebelumnya."
else
  warn "Tidak dapat mendeteksi perintah pm2 startup otomatis. Jalankan 'pm2 startup' secara manual lalu ikuti instruksinya jika auto-start belum aktif."
fi

# Cek kesehatan: pastikan aplikasi benar-benar menjawab di port yang diharapkan
info "Menunggu aplikasi siap..."
HEALTH_OK=false
for _ in $(seq 1 15); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/admin/login" 2>/dev/null; then HEALTH_OK=true; break; fi
  sleep 2
done
if [ "$HEALTH_OK" = true ]; then
  ok "Aplikasi merespons di http://127.0.0.1:${APP_PORT}."
else
  warn "Aplikasi belum merespons di port ${APP_PORT}. Periksa: pm2 logs $APP_NAME --lines 50"
fi

# Ringkasan

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
