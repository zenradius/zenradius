# ZenRadius License Registry API

Cloudflare Worker + D1 untuk mencatat serial yang diterbitkan KeyGen dan heartbeat harian dari server ZenRadius pelanggan.

## Deploy (sekali)

```powershell
cd license-api
npx wrangler login
npx wrangler d1 create zenradius-license          # salin database_id ke wrangler.toml
npx wrangler d1 execute zenradius-license --remote --file=schema.sql
npx wrangler secret put MASTER_SECRET             # sama dengan MASTER_SECRET di domainLicenseService.js (juga jadi kunci dashboard)
npx wrangler deploy
```

Custom domain `api.license.zenradius.net` dibuat otomatis oleh `routes` di `wrangler.toml` (zona harus ada di akun yang sama).

## Endpoint

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| POST | `/api/heartbeat` | — (HMAC serial divalidasi) | `{domain, serial, app_version, node_version}` dari server pelanggan |
| GET | `/api/auth` | Bearer MASTER_SECRET | Cek kunci dashboard |
| POST | `/api/issue` | Bearer MASTER_SECRET | `{domain, serial, issued_by?, note?}` dari KeyGen |
| GET | `/api/list?q=` | Bearer MASTER_SECRET | Gabungan lisensi + instalasi |
| GET | `/api/stats` | Bearer MASTER_SECRET | Ringkasan angka |
| DELETE | `/api/license/:domain` | Bearer MASTER_SECRET | Hapus catatan issue |
| GET | `/health` | — | Ping |

## Uji cepat

```powershell
curl https://api.license.zenradius.net/health
curl -X POST https://api.license.zenradius.net/api/heartbeat -H "content-type: application/json" -d '{"domain":"demo.contoh.id","serial":"XXXX-XXXX-XXXX-XXXX","app_version":"1.0.0"}'
curl https://api.license.zenradius.net/api/stats -H "authorization: Bearer <MASTER_SECRET>"
```
