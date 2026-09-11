#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# ZenRadius — Skrip Instalasi Otomatis VPS
# ═══════════════════════════════════════════════════════════════════════════
# Fungsi skrip ini:
#   1. Clone repository dari GitHub (jika folder belum ada) ATAU
#      menyinkronkan (git pull) jika folder sudah merupakan hasil clone.
#   2. Memverifikasi remote origin mengarah ke repo resmi ZenRadius.
#   3. Memasang dependensi Node.js (npm ci/install).
#   4. Menyiapkan file .env dari .env.example (jika belum ada).
#   5. Menjalankan migrasi/verifikasi database.
#   6. Menjalankan aplikasi via PM2 dan mendaftarkannya agar auto-start
#      saat server reboot (pm2 startup + pm2 save).
#
# Cara pakai (di VPS, sekali jalan saat instalasi awal):
#   curl -fsSL https://raw.githubusercontent.com/zenradius/zenradius/main/scripts/install-vps.sh -o install-vps.sh
#   chmod +x install-vps.sh
#   ./install-vps.sh
#
# Atau jika repo sudah di-clone manual:
#   cd /path/to/zenradius
#   bash scripts/install-vps.sh
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO_URL="https://github.com/zenradius/zenradius.git"
APP_DIR="${ZENRADIUS_DIR:-$(pwd)}"
APP_NAME="zenradius"
BRANCH="main"

info()  { echo -e "\033[1;36m[INFO]\033[0m $1"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m $1"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m $1"; }
fail()  { echo -e "\033[1;31m[GAGAL]\033[0m $1"; exit 1; }

command -v git >/dev/null 2>&1 || fail "Git belum terpasang. Jalankan: sudo apt install git -y"
command -v node >/dev/null 2>&1 || fail "Node.js belum terpasang. Pasang Node.js v18+ terlebih dahulu."
command -v npm  >/dev/null 2>&1 || fail "npm belum terpasang (biasanya satu paket dengan Node.js)."

# ── 1. Clone atau Sinkronisasi Repository ──────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  info "Folder sudah berupa git repository di: $APP_DIR"
  cd "$APP_DIR"

  CURRENT_REMOTE="$(git config --get remote.origin.url || echo '-')"
  if [ "$CURRENT_REMOTE" != "$REPO_URL" ]; then
    warn "Remote origin ($CURRENT_REMOTE) tidak sama dengan repo resmi ($REPO_URL)."
    warn "Skrip tetap lanjut, tapi pastikan ini repo yang benar."
  else
    ok "Remote origin terverifikasi: $CURRENT_REMOTE"
  fi

  info "Menyinkronkan kode terbaru dari GitHub (git pull)..."
  git fetch --prune origin
  git pull origin "$BRANCH"
  ok "Sinkronisasi kode selesai."
else
  info "Folder belum berupa git repository. Melakukan clone dari GitHub..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
  ok "Clone repository selesai ke: $APP_DIR"
fi

# ── 2. Pasang Dependensi Node.js ────────────────────────────────────────────
info "Memasang dependensi Node.js (npm ci --omit=dev)..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "Dependensi Node.js terpasang."

# ── 3. Siapkan Environment (.env) ───────────────────────────────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn "File .env dibuat dari .env.example. SEGERA edit nilai kredensialnya sebelum menjalankan di production!"
  else
    warn "Berkas .env.example tidak ditemukan — pastikan Anda membuat .env secara manual."
  fi
else
  ok "File .env sudah ada, tidak ditimpa."
fi

# ── 4. Verifikasi / Migrasi Database ────────────────────────────────────────
if [ -f scripts/verify-database.js ]; then
  info "Menjalankan verifikasi struktur database..."
  node scripts/verify-database.js || warn "Verifikasi database menampilkan peringatan — periksa log di atas."
fi

# ── 5. Jalankan Aplikasi via PM2 (auto-start saat reboot) ───────────────────
if command -v pm2 >/dev/null 2>&1; then
  info "PM2 terdeteksi. Menjalankan aplikasi via PM2..."
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 reload "$APP_NAME"
    ok "Aplikasi '$APP_NAME' berhasil di-reload via PM2."
  else
    pm2 start app-customer.js --name "$APP_NAME"
    ok "Aplikasi '$APP_NAME' berhasil dijalankan via PM2."
  fi
  pm2 save
  info "Mendaftarkan PM2 agar auto-start saat server reboot..."
  pm2 startup systemd -u "$(whoami)" --hp "$HOME" | tail -n 5 || true
  warn "Jika ada perintah 'sudo env PATH=...' yang ditampilkan PM2 di atas, jalankan SEKALI secara manual untuk mengaktifkan auto-start."
else
  warn "PM2 tidak ditemukan. Memasang PM2 secara global..."
  npm install -g pm2
  pm2 start app-customer.js --name "$APP_NAME"
  pm2 save
  pm2 startup systemd -u "$(whoami)" --hp "$HOME" | tail -n 5 || true
  warn "Jalankan perintah 'sudo env PATH=...' yang ditampilkan PM2 di atas (jika ada) untuk mengaktifkan auto-start saat reboot."
fi

echo ""
ok "═══════════════════════════════════════════════════════════════"
ok " Instalasi ZenRadius selesai!"
ok " Direktori aplikasi : $APP_DIR"
ok " Cek status PM2     : pm2 list"
ok " Lihat log aplikasi : pm2 logs $APP_NAME"
ok " Update berikutnya  : gunakan menu 'Update GitHub' di panel admin"
ok "                      atau jalankan ulang skrip ini."
ok "═══════════════════════════════════════════════════════════════"
