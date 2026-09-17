/** Service: Integrasi Payment Gateway (Multi-Gateway) */
const axios = require('axios');
const crypto = require('crypto');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');

/**
 * Helper: Format pesan error dari response API Gateway agar tampil manusiawi & cantik
 */
function formatGatewayError(gatewayName, error) {
  const respData = error.response ? error.response.data : null;
  let cleanMsg = '';

  if (respData) {
    if (typeof respData === 'string') {
      cleanMsg = respData;
    } else if (Array.isArray(respData.error_messages) && respData.error_messages.length > 0) {
      cleanMsg = respData.error_messages.join(', ');
    } else if (respData.message) {
      cleanMsg = respData.message;
    } else if (respData.statusMessage) {
      cleanMsg = respData.statusMessage;
    } else if (respData.error_code) {
      cleanMsg = respData.error_code;
    } else {
      try {
        cleanMsg = JSON.stringify(respData);
      } catch (e) {
        cleanMsg = String(respData);
      }
    }
  } else {
    cleanMsg = error.message || String(error || 'Terjadi kesalahan pada Payment Gateway');
  }

  logger.error(`[${gatewayName}] Error: ${cleanMsg}`);
  return new Error(`${gatewayName}: ${cleanMsg}`);
}

/**
 * Generate fallback email based on phone number
 */
function getFallbackEmail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `cust${digits || '08123456789'}@zenradius.net`;
}

/**
 * Normalize phone number for Payment Gateway
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (!digits.startsWith('62')) {
    digits = '62' + digits;
  }
  return digits;
}

/**
 * Tripay: Membuat Transaksi
 */
async function createTripayTransaction(invoice, customer, method = 'QRIS', appUrl = '', opts = {}) {
  const settings = getSettingsWithCache();
  const apiKey = settings.tripay_api_key;
  const privateKey = settings.tripay_private_key;
  const merchantCode = settings.tripay_merchant_code;
  const isLive = settings.tripay_mode === 'live' || settings.tripay_mode === 'production';
  
  if (!apiKey || !privateKey || !merchantCode) {
    throw new Error('Tripay Error: Pengaturan API Key, Private Key, atau Merchant Code belum diisi.');
  }

  const baseUrl = isLive 
    ? 'https://tripay.co.id/api/transaction/create' 
    : 'https://tripay.co.id/api-sandbox/transaction/create';

  const prefix = String(opts.orderPrefix || 'INV').toUpperCase();
  const merchantRef = `${prefix}-${invoice.id}-${Date.now()}`;
  const amount = Number(invoice.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Tripay Error: Nominal tagihan tidak valid');
  }

  const signature = crypto.createHmac('sha256', privateKey)
    .update(merchantCode + merchantRef + amount)
    .digest('hex');

  const finalAppUrl = appUrl || settings.app_url || '';
  const phone = normalizePhone(customer.phone || '0');
  const email = customer.email || getFallbackEmail(phone);
  const itemName =
    String(opts.itemName || invoice.item_name || '').trim() ||
    (invoice.period_month && invoice.period_year
      ? `Tagihan Internet Periode ${invoice.period_month}/${invoice.period_year}`
      : `Pembayaran #${invoice.id}`);
  const sku = String(opts.sku || invoice.sku || `ITEM-${invoice.id}`).trim() || `ITEM-${invoice.id}`;
  const callbackPath = String(opts.callbackPath || '/customer/payment/callback');
  const returnPath = String(opts.returnPath || '/customer/dashboard');

  const payload = {
    method: method,
    merchant_ref: merchantRef,
    amount: amount,
    customer_name: customer.name || 'Pelanggan',
    customer_email: email,
    customer_phone: phone,
    order_items: [
      {
        sku: sku,
        name: itemName,
        price: amount,
        quantity: 1
      }
    ],
    signature: signature,
    callback_url: finalAppUrl ? `${finalAppUrl}${callbackPath}` : undefined,
    return_url: finalAppUrl ? `${finalAppUrl}${returnPath}` : undefined
  };

  try {
    const res = await axios.post(baseUrl, payload, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    
    if (res.data && res.data.success) {
      return {
        success: true,
        link: res.data.data.checkout_url,
        reference: res.data.data.reference,
        order_id: merchantRef,
        payload: res.data.data
      };
    }
    throw new Error(res.data.message || 'Gagal membuat transaksi di Tripay');
  } catch (error) {
    throw formatGatewayError('Tripay', error);
  }
}

/**
 * Midtrans: Membuat Transaksi (Snap)
 */
async function createMidtransTransaction(invoice, customer, method = 'snap', appUrl = '', opts = {}) {
  const settings = getSettingsWithCache();
  const serverKey = settings.midtrans_server_key;
  const isLive = settings.midtrans_mode === 'live' || settings.midtrans_mode === 'production';
  
  if (!serverKey) {
    throw new Error('Midtrans Error: Server Key belum diatur di pengaturan.');
  }

  const baseUrl = isLive
    ? 'https://app.midtrans.com/snap/v1/transactions'
    : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

  const prefix = String(opts.orderPrefix || 'INV').toUpperCase();
  const orderId = `${prefix}-${invoice.id}-${Date.now()}`;
  const finalAppUrl = appUrl || settings.app_url || '';
  const phone = normalizePhone(customer.phone || '0');
  const email = customer.email || getFallbackEmail(phone);
  const itemName =
    String(opts.itemName || invoice.item_name || '').trim() ||
    (invoice.period_month && invoice.period_year
      ? `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`
      : `Pembayaran #${invoice.id}`);
  const sku = String(opts.sku || invoice.sku || `ITEM-${invoice.id}`).trim() || `ITEM-${invoice.id}`;
  const returnPath = String(opts.returnPath || '/customer/dashboard');
  
  const payload = {
    transaction_details: {
      order_id: orderId,
      gross_amount: invoice.amount
    },
    customer_details: {
      first_name: customer.name,
      email: email,
      phone: phone
    },
    item_details: [{
      id: sku,
      price: invoice.amount,
      quantity: 1,
      name: itemName
    }]
  };

  if (method !== 'snap') {
    const methodMap = {
      'QRIS': ['gopay', 'qris'],
      'MANDIRIVA': ['echannel'],
      'BRIVA': ['bri_va'],
      'BNIVA': ['bni_va'],
      'BCAVA': ['bca_va'],
      'PERMATAVA': ['permata_va']
    };
    if (methodMap[method]) {
      payload.enabled_payments = methodMap[method];
    }
  }

  if (finalAppUrl) {
    payload.callbacks = {
      finish: `${finalAppUrl}${returnPath}`,
      error: `${finalAppUrl}${returnPath}`,
      pending: `${finalAppUrl}${returnPath}`
    };
  }

  const auth = Buffer.from(serverKey + ':').toString('base64');

  try {
    const res = await axios.post(baseUrl, payload, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });

    return {
      success: true,
      link: res.data.redirect_url,
      reference: res.data.token,
      order_id: orderId,
      payload: res.data
    };
  } catch (error) {
    throw formatGatewayError('Midtrans', error);
  }
}

/**
 * Xendit: Membuat Invoice (Checkout Link)
 */
async function createXenditTransaction(invoice, customer, method = 'xendit', appUrl = '', opts = {}) {
  const settings = getSettingsWithCache();
  const apiKey = settings.xendit_api_key;
  
  if (!apiKey) {
    throw new Error('Xendit Error: API Key belum diatur di pengaturan.');
  }

  const prefix = String(opts.orderPrefix || 'INV').toUpperCase();
  const orderId = `${prefix}-${invoice.id}-${Date.now()}`;
  const finalAppUrl = appUrl || settings.app_url || '';
  const phone = normalizePhone(customer.phone || '0');
  const email = customer.email || getFallbackEmail(phone);
  const itemName =
    String(opts.itemName || invoice.item_name || '').trim() ||
    (invoice.period_month && invoice.period_year
      ? `Internet ${invoice.period_month}/${invoice.period_year}`
      : `Pembayaran #${invoice.id}`);
  const description =
    String(opts.description || invoice.description || '').trim() ||
    (invoice.period_month && invoice.period_year
      ? `Tagihan Internet Periode ${invoice.period_month}/${invoice.period_year}`
      : itemName);
  const returnPath = String(opts.returnPath || '/customer/dashboard');

  const payload = {
    external_id: orderId,
    amount: invoice.amount,
    description: description,
    invoice_duration: 86400, 
    customer: {
      given_names: customer.name,
      email: email,
      mobile_number: phone
    },
    success_redirect_url: `${finalAppUrl}${returnPath}`,
    failure_redirect_url: `${finalAppUrl}${returnPath}`,
    currency: 'IDR',
    items: [{
      name: itemName,
      quantity: 1,
      price: invoice.amount
    }]
  };

  if (method !== 'xendit') {
    const methodMap = {
      'QRIS': ['QRIS'],
      'MANDIRIVA': ['MANDIRI'],
      'BRIVA': ['BRI'],
      'BNIVA': ['BNI'],
      'BCAVA': ['BCA'],
      'PERMATAVA': ['PERMATA']
    };
    if (methodMap[method]) {
      payload.payment_methods = methodMap[method];
    }
  }

  const auth = Buffer.from(apiKey + ':').toString('base64');

  try {
    const res = await axios.post('https://api.xendit.co/v2/invoices', payload, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      link: res.data.invoice_url,
      reference: res.data.id,
      order_id: orderId,
      payload: res.data
    };
  } catch (error) {
    throw formatGatewayError('Xendit', error);
  }
}

/**
 * Duitku: Membuat Transaksi (Checkout Link via Inquiry)
 */
async function createDuitkuTransaction(invoice, customer, method = 'duitku', appUrl = '', opts = {}) {
  const settings = getSettingsWithCache();
  const merchantCode = settings.duitku_merchant_code;
  const apiKey = settings.duitku_api_key;
  const isLive = settings.duitku_mode === 'live' || settings.duitku_mode === 'production';
  
  if (!merchantCode || !apiKey) {
    throw new Error('Duitku Error: Merchant Code atau API Key belum diatur.');
  }

  const baseUrl = isLive 
    ? 'https://passport.duitku.com/webapi/api/merchant/v2/inquiry'
    : 'https://passport-sandbox.duitku.com/webapi/api/merchant/v2/inquiry';

  const prefix = String(opts.orderPrefix || 'INV').toUpperCase();
  const orderId = `${prefix}-${invoice.id}-${Date.now()}`;
  const amount = Number(invoice.amount || 0);
  const finalAppUrl = appUrl || settings.app_url || '';
  const productDetails =
    String(opts.itemName || invoice.item_name || '').trim() ||
    (invoice.period_month && invoice.period_year
      ? `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`
      : `Pembayaran #${invoice.id}`);
  const callbackPath = String(opts.callbackPath || '/customer/payment/callback');
  const returnPath = String(opts.returnPath || '/customer/dashboard');

  const signature = crypto.createHash('md5')
    .update(merchantCode + orderId + amount + apiKey)
    .digest('hex');

  const payload = {
    merchantCode,
    paymentAmount: amount,
    merchantOrderId: orderId,
    productDetails: productDetails,
    email: customer.email || getFallbackEmail(customer.phone),
    phoneNumber: normalizePhone(customer.phone),
    customerVaName: customer.name,
    callbackUrl: `${finalAppUrl}${callbackPath}`,
    returnUrl: `${finalAppUrl}${returnPath}`,
    signature,
    expiryPeriod: 1440 
  };

  const methodMap = {
    'QRIS': 'DQ',
    'MANDIRIVA': 'M2',
    'BRIVA': 'BR',
    'BNIVA': 'I1',
    'BCAVA': 'BC',
    'PERMATAVA': 'BT'
  };
  const methodKey = String(method || '').trim().toUpperCase();
  payload.paymentMethod = methodMap[methodKey] || 'DQ';

  try {
    const res = await axios.post(baseUrl, payload);
    if (res.data && res.data.paymentUrl) {
      return {
        success: true,
        link: res.data.paymentUrl,
        reference: res.data.reference || orderId,
        order_id: orderId,
        payload: res.data
      };
    }
    throw new Error(res.data.statusMessage || 'Gagal mendapatkan payment URL dari Duitku');
  } catch (error) {
    throw formatGatewayError('Duitku', error);
  }
}

/**
 * iPaymu: Membuat Direct Payment.
 * Signature: HMAC-SHA256("POST:VA:SHA256(body):API_KEY", API_KEY).
 * Ref: https://docs.ipaymu.com/id/docs/payment/direct-payment
 */
async function createIpaymuTransaction(invoice, customer, method = 'ipaymu', appUrl = '', opts = {}) {
  const settings = getSettingsWithCache();
  const va = String(settings.ipaymu_va || '').trim();
  const apiKey = String(settings.ipaymu_api_key || '').trim();
  const isLive = ['live', 'production'].includes(String(settings.ipaymu_mode || '').toLowerCase());
  if (!va || !apiKey) throw new Error('iPaymu Error: Nomor VA atau API Key belum diatur.');

  const amount = Math.floor(Number(invoice.amount || 0));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('iPaymu Error: Nominal tagihan tidak valid.');

  const prefix = String(opts.orderPrefix || 'INV').toUpperCase();
  const referenceId = `${prefix}-${invoice.id}-${Date.now()}`;
  const finalAppUrl = String(appUrl || settings.app_url || '').replace(/\/+$/, '');
  if (!finalAppUrl) throw new Error('iPaymu Error: URL aplikasi belum tersedia untuk callback pembayaran.');
  const callbackPath = String(opts.callbackPath || '/customer/payment/callback');
  const returnPath = String(opts.returnPath || '/customer/dashboard');
  const itemName = String(opts.itemName || invoice.item_name || '').trim() || `Pembayaran #${invoice.id}`;

  const methodMap = {
    QRIS: ['qris', 'mpm'],
    BCAVA: ['va', 'bca'],
    BNIVA: ['va', 'bni'],
    BRIVA: ['va', 'bri'],
    PERMATAVA: ['va', 'permata'],
    MANDIRIVA: ['va', 'mandiri'],
    DANA: ['ewallet', 'dana'],
    SHOPEEPAY: ['ewallet', 'shopeepay']
  };
  const requested = String(method || '').trim().toUpperCase();
  const [paymentMethod, paymentChannel] = methodMap[requested] || ['qris', 'mpm'];
  const payload = {
    name: String(customer.name || 'Pelanggan'),
    phone: normalizePhone(customer.phone || '0'),
    email: String(customer.email || getFallbackEmail(customer.phone)).trim(),
    amount,
    notifyUrl: `${finalAppUrl}${callbackPath}`,
    returnUrl: `${finalAppUrl}${returnPath}`,
    cancelUrl: `${finalAppUrl}${returnPath}`,
    expired: 24,
    expiredType: 'hours',
    comments: itemName,
    referenceId,
    paymentMethod,
    paymentChannel,
    product: [itemName],
    qty: [1],
    price: [amount]
  };
  const body = JSON.stringify(payload);
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto.createHmac('sha256', apiKey).update(`POST:${va}:${bodyHash}:${apiKey}`).digest('hex');
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const baseUrl = isLive ? 'https://my.ipaymu.com' : 'https://sandbox.ipaymu.com';

  try {
    const res = await axios.post(`${baseUrl}/api/v2/payment/direct`, body, {
      headers: { 'Content-Type': 'application/json', va, signature, timestamp },
      timeout: 15000
    });
    const data = res.data?.Data || res.data?.data || {};
    if (!(res.data?.Success ?? res.data?.success) || !data.Url && !data.url) {
      throw new Error(res.data?.Message || res.data?.message || 'Gagal mendapatkan URL pembayaran dari iPaymu');
    }
    return {
      success: true,
      link: data.Url || data.url,
      reference: data.ReferenceId || data.referenceId || referenceId,
      order_id: referenceId,
      payload: data
    };
  } catch (error) {
    throw formatGatewayError('iPaymu', error);
  }
}

/**
 * Verifikasi Webhook Signature (Tripay)
 */
function verifyTripayWebhook(jsonBody, signature, privateKey) {
  const callbackSignature = crypto.createHmac('sha256', privateKey)
    .update(jsonBody)
    .digest('hex');
  return callbackSignature === signature;
}

/**
 * Verifikasi Webhook Signature (Midtrans)
 */
function verifyMidtransWebhook(body, serverKey) {
  const { order_id, status_code, gross_amount, signature_key } = body;
  const hash = crypto.createHash('sha512')
    .update(order_id + status_code + gross_amount + serverKey)
    .digest('hex');
  return hash === signature_key;
}

/**
 * Verifikasi Webhook Signature (Duitku)
 */
function verifyDuitkuWebhook(body, apiKey) {
  const { merchantCode, amount, merchantOrderId, signature } = body;
  const hash = crypto.createHash('md5')
    .update(merchantCode + amount + merchantOrderId + apiKey)
    .digest('hex');
  return hash === signature;
}

/** Verifikasi callback iPaymu dengan VA sebagai secret key. */
function verifyIpaymuWebhook(body, signature, va) {
  if (!body || !signature || !va) return false;
  const integerKeys = new Set(['trx_id', 'status_code', 'transaction_status_code', 'paid_off']);
  const normalized = {};
  for (const key of Object.keys(body)) {
    if (key.toLowerCase() === 'signature') continue;
    const value = body[key];
    if (key === 'is_escrow') normalized[key] = value === true || value === 1 || value === '1' || value === 'true';
    else if (integerKeys.has(key)) normalized[key] = parseInt(value, 10);
    else if (key === 'additional_info') normalized[key] = value === '[]' ? [] : value;
    else normalized[key] = String(value ?? '');
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'additional_info')) normalized.additional_info = [];
  const sorted = Object.keys(normalized).sort((a, b) => a.localeCompare(b)).reduce((out, key) => {
    out[key] = normalized[key];
    return out;
  }, {});
  const bodyJson = JSON.stringify(sorted).replace(/\//g, '\\/');
  const expected = crypto.createHmac('sha256', String(va)).update(bodyJson).digest('hex');
  const provided = String(signature).trim().toLowerCase();
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/**
 * Tripay: Mendapatkan Daftar Metode Pembayaran Aktif
 */
async function getTripayChannels() {
  const settings = getSettingsWithCache();
  const apiKey = settings.tripay_api_key;
  const isLive = settings.tripay_mode === 'live' || settings.tripay_mode === 'production';
  
  if (!apiKey) return [];

  const baseUrl = isLive
    ? 'https://tripay.co.id/api/merchant/payment-channel'
    : 'https://tripay.co.id/api-sandbox/merchant/payment-channel';

  try {
    const res = await axios.get(baseUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 3000
    });
    
    if (!res.data || !res.data.success) {
      logger.error('[Tripay] Response tidak success:', res.data);
      return [];
    }
    
    const allChannels = res.data.data || [];
    const activeChannels = allChannels.filter(ch => ch.active === true);
    
    logger.info(`[Tripay] Total channels: ${allChannels.length}, Active: ${activeChannels.length}`);
    return activeChannels;
  } catch (error) {
    logger.error('[Tripay] Gagal ambil channel:', error.message);
    return [];
  }
}

module.exports = {
  createTripayTransaction,
  createMidtransTransaction,
  createXenditTransaction,
  createDuitkuTransaction,
  createIpaymuTransaction,
  getTripayChannels,
  verifyTripayWebhook,
  verifyMidtransWebhook,
  verifyDuitkuWebhook,
  verifyIpaymuWebhook,
  getFallbackEmail
};
