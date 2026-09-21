# Digiflazz Payment Gateway Integration Guide

## Overview
Digiflazz sekarang terintegrasi sebagai **payment gateway option untuk customer public payments** (voucher + invoice).
Selain sebagai PPOB provider (pulsa, token, etc) untuk agent, Digiflazz juga bisa handle pembayaran customer langsung.

## Prerequisites
- ✅ Digiflazz account (merchant/payment gateway, bukan PPOB)
- ✅ Digiflazz API credentials (username, API key)
- ✅ Public domain/URL untuk webhook
- ✅ Webhook secret di-configure

## Payment Gateway Integration vs PPOB

| Aspek | PPOB (Agent) | Payment Gateway (Customer) |
|-------|------|-------------------|
| Endpoint | `/webhook/digiflazz` | `/api/webhook/digiflazz-payment` |
| Parser | None (inline parsing) | `utils/digiflazzPaymentParser.js` |
| Use Case | Reseller pulsa/token/voucher | Customer public voucher/invoice payment |
| Events Handled | Refund, balance update | Payment success, failure |
| DB Table | `digiflazz_webhook_logs` | `webhook_payment_notifs` |

## Setup Steps

### 1. Konfigurasi Webhook Secret
Edit `settings.json` dan pastikan ada `digiflazz_webhook_secret`:

```json
{
  "digiflazz_username": "your-digiflazz-username",
  "digiflazz_api_key": "your-api-key-here",
  "digiflazz_webhook_secret": "your-webhook-secret-min-8-chars",
  "webhook_secret": "system-webhook-secret-min-8-chars"
}
```

### 2. Setup Webhook URL di Digiflazz Dashboard

1. Login ke **Digiflazz merchant dashboard**
2. Navigasi ke **Settings → Webhook Configuration** atau **Integration → Webhook**
3. Untuk **Payment Gateway** webhook, tambah URL baru:
   ```
   https://your-public-domain.com/api/webhook/digiflazz-payment
   ```
4. Pilih event: **Payment Success** atau **Payment Completed**
5. Method: **POST**
6. Header authentication:
   ```
   x-hub-signature: <HMAC-SHA256 signature>
   ```
7. Save & Test webhook

> **PENTING**: Jangan samakan dengan PPOB webhook (/webhook/digiflazz) — itu untuk agent transactions.

### 3. Webhook Payload Format

Digiflazz akan POST data seperti ini ke `/api/webhook/digiflazz-payment`:

```json
{
  "ref_id": "INV-12345",
  "status": "success",
  "amount": 50000,
  "method": "qris",
  "trx_id": "DF-xxxxxxxx",
  "timestamp": "2026-09-21T20:50:00+07:00",
  "description": "Payment for invoice",
  "phone": "6289xxxxxxxxx",
  "signature": "sha256=..."
}
```

### 4. Payment Methods Supported

Digiflazz payment gateway bisa handle:
- ✅ QRIS (same-day settlement)
- ✅ E-Money (DANA, OVO, LinkAja, Shopeepay, GoPay)
- ✅ Transfer Bank (all banks)
- ✅ Virtual Account
- ✅ Credit Card (if enabled)

## How It Works

1. **Customer Selects Gateway**: Di halaman pembayaran, customer pilih "Digiflazz" sebagai payment method
2. **Checkout Created**: ZenRadius membuat checkout link via Digiflazz API
3. **Customer Pays**: Customer membayar via QRIS/e-money/bank transfer
4. **Digiflazz Detects**: Digiflazz instantly confirm pembayaran sukses
5. **Webhook Trigger**: Digiflazz POST ke `/api/webhook/digiflazz-payment` dengan detail pembayaran
6. **ZenRadius Process**:
   - Parse payload → validasi signature
   - Cocokkan amount dengan `qris_amount_unique` di invoices/public_voucher_orders
   - Auto-mark sebagai PAID
   - Fulfill voucher (create hotspot user, kirim WA)
   - Reactivate customer jika suspended
7. **Customer Notified**: Kirim notifikasi WA sukses pembayaran

## Testing Webhook

### Test via cURL (Development)

```bash
# Test Digiflazz payment webhook dengan test payload
curl -X POST "http://localhost:3001/api/webhook/digiflazz-payment" \
  -H "Content-Type: application/json" \
  -d '{
    "ref_id": "TEST-INV-001",
    "status": "success",
    "amount": 50000,
    "method": "qris",
    "trx_id": "DF-TEST-20260921",
    "timestamp": "2026-09-21T20:50:00+07:00",
    "description": "Test payment"
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
2. Catat `qris_amount_unique` dari DB
3. Test webhook dengan amount tersebut:

```bash
curl -X POST "http://localhost:3001/api/webhook/digiflazz-payment" \
  -H "Content-Type: application/json" \
  -d '{
    "ref_id": "VOUCHER-123",
    "status": "success",
    "amount": 52341,
    "method": "qris",
    "trx_id": "DF-REAL-20260921",
    "timestamp": "2026-09-21T20:50:00+07:00"
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

4. Verifikasi di database:
```sql
SELECT id, status, qris_amount_unique, qris_paid_notif_id 
FROM public_voucher_orders 
WHERE id=X;
-- Status seharusnya berubah dari 'pending' → 'paid'
```

## Admin Monitoring

Monitor Digiflazz payment webhooks di:
- **Panel**: `/admin/payment-qris-static` → Tab "Webhook & Notifikasi"
- **Filter**: Service = "digiflazz_payment"
- **Check**: Amount matched, Invoice/Voucher ID, Status

## Troubleshooting

### Issue: Webhook tidak ter-trigger
**Solusi**:
1. Verifikasi webhook URL di Digiflazz dashboard: `https://your-domain.com/api/webhook/digiflazz-payment`
2. Pastikan server accessible dari publik
3. Check firewall rules — endpoint `/api/webhook/digiflazz-payment` tidak di-block
4. Lihat logs: `grep Digiflazz-Payment logs/*.log`

### Issue: Webhook diterima tapi tidak match
**Solusi**:
1. Verifikasi nominal unik: `SELECT qris_amount_unique FROM public_voucher_orders WHERE id=X`
2. Check webhook logs: `sqlite3 data/billing.db "SELECT * FROM webhook_payment_notifs WHERE service='digiflazz_payment' ORDER BY created_at DESC LIMIT 5;"`
3. Pastikan order status masih 'pending'
4. Jika multiple orders dengan amount sama → sistem report "ambiguous"

### Issue: Signature verification failed
**Solusi**:
1. Periksa `digiflazz_webhook_secret` di settings.json cocok dengan key di Digiflazz dashboard
2. Jika Digiflazz tidak mengirim signature, field bisa kosong (sistem skip verification)
3. Cek header signature yang dikirim Digiflazz

### Issue: "Method tidak support" error
**Solusi**:
1. Digiflazz payment gateway harus di-enable di merchant dashboard
2. Setup payment method (QRIS, e-money, bank transfer) terlebih dahulu
3. Test payment via Digiflazz sandbox dulu sebelum production

## Configuration

### settings.json

```json
{
  "digiflazz_username": "merchant_username",
  "digiflazz_api_key": "api_key_here",
  "digiflazz_webhook_secret": "webhook_secret_min_8_chars",
  "digiflazz_webhook_id": "optional_webhook_id",
  "public_base_url": "https://your-domain.com"
}
```

### Environment Variables (Alternative)

```bash
export DIGIFLAZZ_USERNAME="merchant_username"
export DIGIFLAZZ_API_KEY="api_key_here"
export DIGIFLAZZ_WEBHOOK_SECRET="webhook_secret"
```

## API Reference

### Webhook Request Handler
**Endpoint**: `POST /api/webhook/digiflazz-payment`

**Headers**:
- `Content-Type: application/json`
- `x-hub-signature`: HMAC-SHA256 signature (optional)
- `User-Agent`: Digiflazz

**Body** (JSON):
```typescript
{
  ref_id: string;           // Your internal reference (INV-xxx or VOUCHER-xxx)
  status: "success" | "pending" | "failed";
  amount: number;           // Payment amount in Rp
  method: string;           // "qris" | "transfer_bank" | "e_money" | etc
  trx_id?: string;          // Digiflazz transaction ID
  timestamp?: string;       // ISO timestamp
  phone?: string;           // Customer phone (optional)
  description?: string;     // Payment description
  signature?: string;       // HMAC signature for verification
}
```

**Response** (JSON):
```json
{
  "ok": true,
  "message": "Processed",
  "matched": true/false
}
```

### Database Logging
All Digiflazz payment webhooks are logged in `webhook_payment_notifs` table:

```sql
SELECT 
  id, created_at, service, parsed_amount, parsed_ok,
  matched_invoice_id, matched_voucher_order_id, 
  content, ip
FROM webhook_payment_notifs 
WHERE service='digiflazz_payment' 
ORDER BY created_at DESC;
```

## Integration with Customer Portal

**Customer Payment Flow**:
1. Customer browse & select voucher → click "Bayar" (Pay)
2. Select payment method → choose "Digiflazz" or payment gateway
3. Redirect to Digiflazz checkout
4. Customer pay via QRIS/e-money/bank
5. Digiflazz confirm → webhook to `/api/webhook/digiflazz-payment`
6. Auto-fulfill & notify customer

## Production Checklist

- [ ] Digiflazz webhook secret configured in settings.json
- [ ] Public domain set in `public_base_url` setting
- [ ] Webhook URL added to Digiflazz dashboard
- [ ] Test payment with test amount (non-production account if sandbox available)
- [ ] Monitor logs for errors: `grep Digiflazz-Payment logs/*.log`
- [ ] Verify webhook_payment_notifs table populated after test payment
- [ ] Test with real transaction on production account
- [ ] Customer receives WA notification after payment
- [ ] Voucher fulfilled (hotspot user created, code delivered)

## Migration from MacroDroid

Jika masih pakai MacroDroid untuk payment notification:

1. Setup Digiflazz webhook di dashboard (same-day settlement, reliable)
2. Test both simultaneously (MacroDroid + Digiflazz)
3. Monitor logs — confirm Digiflazz webhook working
4. Disable MacroDroid automation setelah stable 1 minggu
5. Keep MacroDroid as backup if needed

## Support & Debug

For detailed logging:
```bash
# Watch Digiflazz webhook logs in real-time
tail -f logs/*.log | grep -i "digiflazz-payment\|webhook.*digiflazz"

# Query webhook notifications
sqlite3 data/billing.db "SELECT * FROM webhook_payment_notifs WHERE service='digiflazz_payment' ORDER BY id DESC LIMIT 20;"
```

---

**Last Updated**: V.1.0.60+ dengan Digiflazz payment gateway webhook support  
**Integration Type**: Direct HTTP POST webhook (payment success notification)
**Settlement**: Same-day or next-day depending on payment method
