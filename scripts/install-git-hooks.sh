#!/usr/bin/env bash
# Pasang git hook lokal agar versi SELALU diperbarui/commit sebelum push.
#
# Hook yang dipasang (pre-push):
#   Menolak `git push` bila ada berkas yang berubah namun `version.txt` dan
#   `package.json` TIDAK ikut di-commit (versi tidak sinkron / tidak di-bump).
#
# Pemakaian:
#   bash scripts/install-git-hooks.sh
#
# Untuk memperbarui versi sebelum commit/push:
#   node scripts/bump-version.js patch     # 1.7.1 -> 1.7.2
#   node scripts/bump-version.js minor     # 1.7.1 -> 1.8.0
#   node scripts/bump-version.js 1.7.5     # versi eksplisit
#   node scripts/bump-version.js --check   # periksa kesinkronan saja

set -euo pipefail

HOOK_DIR="$(git rev-parse --git-dir 2>/dev/null)/hooks"
[ -d "$HOOK_DIR" ] || { echo "✘ Bukan repositori git (folder .git/hooks tidak ditemukan)."; exit 1; }

PREPUSH="$HOOK_DIR/pre-push"

cat > "$PREPUSH" <<'HOOK'
#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# ZenRadius pre-push guard: pastikan version.txt diperbarui.
# Dipasang oleh scripts/install-git-hooks.sh — jangan diedit manual.
# ─────────────────────────────────────────────────────────────
set -uo pipefail

# Berkas yang berubah di commit lokal yang akan didorong (range disediakan git).
base=""
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  case "$local_sha" in
    0000000000000000000000000000000000000000) continue ;; # penghapusan branch
  esac
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ] || [ -z "${remote_sha:-}" ]; then
    # Branch baru di remote: bandingkan dengan upstream/tag terdekat bila ada.
    m="$(git merge-base "$local_sha" "$(git rev-list --max-parents=0 "$local_sha" | tail -n1)" 2>/dev/null || echo "")"
    base="$local_sha"
  else
    base="$local_sha"
    remote_base="$remote_sha"
  fi
done

# Kumpulkan daftar berkas yang berubah pada commit yang belum ada di remote.
changed=""
if [ -n "${remote_base:-}" ]; then
  changed="$(git diff --name-only "$remote_base" "$base" 2>/dev/null || true)"
fi
if [ -z "$changed" ]; then
  # Fallback: commit lokal terakhir vs HEAD~1
  changed="$(git diff --name-only HEAD~1 HEAD 2>/dev/null || true)"
fi
[ -z "$changed" ] && exit 0

non_ver="$(printf '%s\n' "$changed" | grep -v -x -e 'version.txt' -e 'package.json' -e 'package-lock.json' || true)"
has_ver="$(printf '%s\n' "$changed" | grep -x -e 'version.txt' || true)"

if [ -z "$has_ver" ]; then
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo " ✘ PUSH DITOLAK: version.txt belum diperbarui."
  echo "════════════════════════════════════════════════════════════"
  echo " Ada perubahan kode tetapi version.txt tidak ikut di-commit."
  echo ""
  echo " Langkah perbaikan:"
  echo "   node scripts/bump-version.js patch"
  echo "   git add -A && git commit -m 'chore(release): bump versi'"
  echo ""
  echo " Berkas yang berubah:"
  printf '%s\n' "$non_ver" | sed 's/^/   - /'
  echo "════════════════════════════════════════════════════════════"
  exit 1
fi

# Pastikan version.txt & package.json sinkron.
if [ -f version.txt ] && [ -f package.json ] && command -v node >/dev/null 2>&1; then
  v_txt="$(sed 's/^[Vv]\.//' version.txt | tr -d ' \t\n\r')"
  v_pkg="$(node -e "process.stdout.write(String(require('./package.json').version||''))" 2>/dev/null || echo "")"
  if [ -n "$v_pkg" ] && [ "$v_txt" != "$v_pkg" ]; then
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo " ✘ PUSH DITOLAK: versi version.txt dan package.json berbeda."
    echo "   version.txt  : $v_txt"
    echo "   package.json : $v_pkg"
    echo "   Perbaiki dengan: node scripts/bump-version.js <versi|patch|minor|major>"
    echo "════════════════════════════════════════════════════════════"
    exit 1
  fi
fi

exit 0
HOOK

chmod +x "$PREPUSH"
echo "✔ Git hook dipasang: $PREPUSH"
echo "  Setiap 'git push' akan menolak bila version.txt belum diperbarui/sinkron."
