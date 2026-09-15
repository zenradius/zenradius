/**
 * License Trust Anchor
 * Kunci PUBLIK Ed25519 penerbit lisensi ZenRadius. Hanya kunci publik yang
 * disimpan di aplikasi; kunci privat berada di lingkungan penerbitan
 * (Cloudflare Worker secret LICENSE_SIGNING_KEY) dan tidak pernah didistribusikan.
 *
 * Format token lisensi (v3):  ZRL1.<base64url(payload JSON)>.<base64url(signature 64B)>
 * Payload: { v:1, lid, sub, ic, iat, exp|null, plan }
 *   lid  = license id unik (untuk revokasi di registry)
 *   sub  = subjek lisensi: domain ternormalisasi, IP publik, atau 'local'
 *   ic   = Kode Instalasi (XXXX-XXXX-XXXX) — pengikat ke instalasi
 *   iat  = diterbitkan (epoch detik), exp = kedaluwarsa (epoch detik) atau null = lifetime
 *
 * Rotasi kunci: tambahkan kid baru ke PUBLIC_KEYS, terbitkan ulang, lalu hapus kid lama.
 */
const PUBLIC_KEYS = {
  // kid → raw public key Ed25519 (32 byte, base64url)
  k1: 'iq0AlNEZHWqRtLw4hFrXSrgfYLvisy9XYK89EIMIaL8'
};

const DEFAULT_KID = 'k1';
const TOKEN_PREFIX = 'ZRL1';

module.exports = { PUBLIC_KEYS, DEFAULT_KID, TOKEN_PREFIX };
