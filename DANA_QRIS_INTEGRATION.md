# DANA Bisnis QRIS Statis Integration Guide

## Overview
ZenRadius sekarang support otomatis notifikasi pembayaran QRIS dari DANA Bisnis tanpa menggunakan MacroDroid atau aplikasi pihak ketiga lainnya.

## Prerequisites
- ✅ DANA Bisnis account (sudah aktif)
- ✅ QRIS Statis dari DANA (payload sudah ter-setup di settings.json)
- ✅ Public domain/URL untuk webhook (tidak bisa localhost)
- ✅ Webhook secret di-configure

## Setup Steps

### 1. Konfigurasi Webhook Secret (WAJIB)
Edit `settings.json` dan pastikan ada `webhook_secret` minimal 8 karakter:

```json
{
  "webhook_secret": "zenradius-webhook-secret-min-8-chars",
  "dana_webhook_secret": "dana-specific-secret-if-needed",
  "qris_static_enabled": true,
  "qris_static_payload": "00020101021126570011ID.DANA.WWW...",
  "qris_static_qr_url": "/uploads/qris/qris-xxx.png"
}
```

### 2. Setup Webhook URL di DANA Bisnis Dashboard

1. Login ke **https://bisnis.dana.id**
2. Navigasi ke **Settings → API/Webhook Configuration** atau **Integration → Webhook**
3. Tambah Webhook URL baru:
   ```
   https://your-public-domain.com/api/webhook/dana
   ```
4. Pilih event: **Payment Received** atau **Transaction Success**
5. Method: **POST**
6. Header (jika DANA support):
   ```
   x-webhook-secret: dana-specific-secret-if-needed
   ```
7. Save & Test webhook

### 3. Webhook Format yang Diharapkan

DANA akan POST data seperti ini ke `/api/webhook/dana`:

```json
{
  "transactionId": "TXN-20260921-12345",
  "amount": 50000,
  "currency": "IDR",
  "status": "SUCCESS",
  "timestamp": "2026-09-21T20:50:00+07:00",
  "reference": "VOUCHER-12345",
  "description": "Payment QRIS"
}
```

## How It Works

1. **Customer Transfer via QRIS**: Pelanggan scan QRIS dengan DANA/OVO/GoPay/dll, bayar nominal unik yang diberikan
2. **DANA Detects**: DANA menerima transaksi, konfirmasi sukses
3. **Webhook Trigger**: DANA otomatis POST ke `/api/webhook/dana` dengan detail pembayaran
4. **ZenRadius Process**:
   - Terima & parse payload DANA
   - Validasi signature (jika ada)
   - Cocokkan amount dengan `qris_amount_unique` di `invoices` atau `public_voucher_orders`
   - Auto-mark sebagai **PAID**
   - Fulfill voucher (create hotspot user, kirim WA)
   - Aktivasi kembali customer jika suspended
5. **Customer Notified**: Kirim notifikasi WA sukses pembayaran

## Testing Webhook

### Test via cURL (Development)

```bash
# Test DANA webhook dengan test payload
curl -X POST "http://localhost:3001/api/webhook/dana" \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "TXN-TEST-20260921",
    "amount": 50000,
    "currency": "IDR",
    "status": "SUCCESS",
    "timestamp": "2026-09-21T20:50:00+07:00",
    "reference": "TEST-VOUCHER",
    "description": "Test QRIS Payment"
  }'
```

Expected response:
```json
{
  "ok": true,
  "message": "Processed",
  "matched": false
}
```

### Test dengan Nominal Unik Sebenarnya

1. Buat order voucher di ZenRadius (misal: Rp 52.341 dengan unique code 341)
2. Catat `qris_amount_unique` dari DB: `SELECT qris_amount_unique FROM public_voucher_orders WHERE id=X`
3. Test webhook dengan amount tersebut:

```bash
curl -X POST "http://localhost:3001/api/webhook/dana" \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "TXN-REAL-20260921",
    "amount": 52341,
    "currency": "IDR",
    "status": "SUCCESS",
    "timestamp": "2026-09-21T20:50:00+07:00",
    "reference": "VOUCHER-123",
    "description": "Real QRIS Payment Test"
  }'
```

Expected response (jika match):
```json
{
  "ok": true,
  "message": "Processed",
  "matched": true
}
```

3. Verifikasi di database:
```sql
SELECT id, status, qris_amount_unique, qris_paid_notif_id 
FROM public_voucher_orders 
WHERE id=X;
-- Status seharusnya berubah dari 'pending' → 'paid'
```

## Monitoring & Logs

### Check Webhook Logs

```bash
# Lihat last 50 webhook notifikasi
sqlite3 data/billing.db "SELECT * FROM webhook_payment_notifs ORDER BY created_at DESC LIMIT 50;"

# Filter DANA webhook saja
sqlite3 data/billing.db "SELECT * FROM webhook_payment_notifs WHERE service='dana' ORDER BY created_at DESC LIMIT 20;"
```

### Check Application Logs

```bash
# Tail logs dengan filter DANA
tail -f logs/*.log | grep -i "WEBHOOK\]\[DANA"

# Lihat payment notif logs
grep "WEBHOOK\]\[payment-notif\|WEBHOOK\]\[DANA" logs/*.log | tail -50
```

## Troubleshooting

### Issue: Webhook tidak ter-trigger
**Solusi**:
1. Verifikasi webhook URL di DANA dashboard: `https://your-domain.com/api/webhook/dana`
2. Pastikan server Anda accessible dari publik (test: `curl https://your-domain.com/api/webhook/dana` dari luar)
3. Check firewall/nginx rules — pastikan endpoint `/api/webhook/dana` tidak di-block
4. Lihat logs: `grep DANA logs/*.log`

### Issue: Webhook diterima tapi tidak match
**Solusi**:
1. Verifikasi nominal unik: `SELECT qris_amount_unique FROM public_voucher_orders WHERE id=X`
2. Check webhook logs: `sqlite3 data/billing.db "SELECT * FROM webhook_payment_notifs WHERE service='dana' ORDER BY created_at DESC LIMIT 5;"`
3. Pastikan order status masih 'pending' (bukan sudah 'paid' atau 'cancelled')
4. Jika multiple orders dengan amount sama, sistem akan report "ambiguous" — modifikasi nominal unik strategy jika perlu

### Issue: Signature verification failed
**Solusi**:
1. Periksa `dana_webhook_secret` di settings.json cocok dengan key di DANA dashboard
2. Jika DANA tidak mengirim signature, biarkan field `dana_webhook_secret` kosong (sistem akan skip verification)
3. Cek header yang dikirim DANA: `grep "x-signature\|x-dana-signature" logs/*.log`

## Advanced: Fallback to Manual Trigger

Jika DANA webhook tidak dapat di-setup, gunakan endpoint generic `/api/webhook/v1/payment-notif`:

```bash
curl -X POST "http://localhost:3001/api/webhook/v1/payment-notif?service=dana" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: webhook-secret-from-settings" \
  -d 'Pembayaran QRIS Rp 50000 berhasil'
```

## Migration from MacroDroid

Jika Anda sebelumnya gunakan MacroDroid:

1. **Backup**: Simpan config MacroDroid automation (untuk reference)
2. **Disable**: Non-aktifkan MacroDroid automation di device
3. **Test DANA Webhook**: Ikuti setup di atas
4. **Monitor**: Pastikan pembayaran masuk terdeteksi otomatis
5. **Remove**: Hapus MacroDroid app dari device setelah stable 1 minggu

## Reference

### Database Schema (webhook_payment_notifs)
```sql
CREATE TABLE webhook_payment_notifs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT,           -- 'dana', 'tripay', 'manual', etc.
  content TEXT,           -- Raw payload
  parsed_amount INTEGER,  -- Extracted amount in Rp
  parsed_ok INTEGER,      -- 1 if successfully parsed
  matched_invoice_id INTEGER,
  matched_voucher_order_id INTEGER,
  matched_donation_order_id INTEGER,
  qris_paid_notif_id INTEGER,
  ip TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Webhook Endpoint Summary

| Endpoint | Method | Purpose | Requires Secret |
|----------|--------|---------|-----------------|
| `/api/webhook/dana` | POST | DANA Bisnis payment notif | Optional (x-signature) |
| `/api/webhook/v1/payment-notif` | POST | Generic payment notif (manual/SMS/etc) | Yes (x-webhook-secret) |
| `/webhook/digiflazz` | POST | Digiflazz webhook | Yes (x-signature) |
| `/api/meta-webhook` | POST | Meta WhatsApp | Yes (signature) |

## Support

Untuk debug lebih lanjut atau pertanyaan:
1. Cek logs di `logs/` directory
2. Query `webhook_payment_notifs` table di database
3. Pastikan `webhook_secret` di-configure dengan benar
4. Test curl command di atas sebelum test dengan transaksi asli

---

**Last Updated**: V.1.0.58+ dengan DANA Bisnis webhook support  
**Integration Type**: Direct HTTP POST webhook (tidak perlu third-party app)
