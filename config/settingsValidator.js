/**
 * Settings Validation Schema
 * Validate setiap field sebelum di-save ke settings.json
 */
const { logger } = require('./logger');

// Validation rules untuk setiap field
const VALIDATION_RULES = {
  // Server Configuration
  server_port: {
    type: 'number',
    min: 1024,
    max: 65535,
    required: true,
    description: 'Port server (1024-65535)'
  },
  server_host: {
    type: 'string',
    required: true,
    description: 'Host server'
  },
  session_secret: {
    type: 'string',
    minLength: 32,
    required: true,
    description: 'Session secret (min 32 karakter)'
  },

  // Company Information
  company_header: {
    type: 'string',
    maxLength: 100,
    required: true,
    description: 'Nama perusahaan'
  },
  public_base_url: {
    type: 'string',
    pattern: /^https?:\/\/.+/,
    description: 'URL publik aplikasi (http://... atau https://...)'
  },
  company_manager: {
    type: 'string',
    maxLength: 100,
    description: 'Nama manager'
  },
  company_phone: {
    type: 'string',
    pattern: /^[0-9\-\+\s]+$/,
    description: 'Nomor telepon perusahaan'
  },
  company_email: {
    type: 'string',
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    description: 'Email perusahaan'
  },
  company_address: {
    type: 'string',
    maxLength: 500,
    description: 'Alamat perusahaan'
  },
  footer_info: {
    type: 'string',
    maxLength: 200,
    description: 'Footer info'
  },
  operational_hours: {
    type: 'string',
    maxLength: 200,
    description: 'Jam operasional'
  },

  // Admin Credentials
  admin_username: {
    type: 'string',
    minLength: 3,
    maxLength: 50,
    required: true,
    description: 'Username admin'
  },
  admin_password: {
    type: 'string',
    minLength: 6,
    required: true,
    description: 'Password admin (min 6 karakter)'
  },
  admin_api_key: {
    type: 'string',
    minLength: 10,
    description: 'API key admin'
  },
  admin_permissions: {
    type: 'object',
    description: 'Permission personal admin (opsional — admin kini full-access)'
  },

  // GenieACS Configuration
  genieacs_url: {
    type: 'string',
    pattern: /^https?:\/\/.+/,
    description: 'URL GenieACS (http://...)'
  },
  genieacs_username: {
    type: 'string',
    description: 'Username GenieACS'
  },
  genieacs_password: {
    type: 'string',
    description: 'Password GenieACS'
  },

  // MikroTik Configuration
  mikrotik_name: {
    type: 'string',
    minLength: 1,
    description: 'Nama MikroTik yang tampil di panel admin'
  },
  mikrotik_host: {
    type: 'string',
    pattern: /^(\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9\-\.]+$/,
    description: 'Host MikroTik (IP atau hostname)'
  },
  mikrotik_user: {
    type: 'string',
    minLength: 1,
    description: 'Username MikroTik'
  },
  mikrotik_password: {
    type: 'string',
    minLength: 1,
    description: 'Password MikroTik'
  },
  mikrotik_port: {
    type: 'number',
    min: 1024,
    max: 65535,
    description: 'Port MikroTik'
  },
  isolir_day: {
    type: 'number',
    min: 1,
    max: 365,
    description: 'Hari isolir (1-365)'
  },

  // WhatsApp Configuration
  whatsapp_enabled: {
    type: 'boolean',
    description: 'Enable WhatsApp'
  },
  whatsapp_auth_folder: {
    type: 'string',
    description: 'Folder auth WhatsApp'
  },
  whatsapp_broadcast_delay: {
    type: 'number',
    min: 1,
    max: 60,
    description: 'Delay broadcast WhatsApp (detik)'
  },
  wa_gateway_type: {
    type: 'string',
    enum: ['baileys', 'meta', 'fonnte', 'wablas', 'http'],
    description: 'WA gateway type'
  },
  fonnte_token: { type: 'string', description: 'Fonnte Authorization token' },
  fonnte_url: { type: 'string', description: 'Fonnte API URL' },
  wablas_domain: { type: 'string', description: 'Wablas domain' },
  wablas_token: { type: 'string', description: 'Wablas Authorization token' },
  http_wa_url: { type: 'string', description: 'HTTP WA gateway URL' },
  http_wa_token: { type: 'string', description: 'HTTP WA Authorization header' },
  http_wa_method: { type: 'string', enum: ['POST', 'GET'], description: 'HTTP WA method' },
  http_wa_payload: { type: 'string', description: 'Custom payload JSON template' },
  http_wa_header_name: { type: 'string', description: 'Custom header name' },
  http_wa_headers: { type: 'string', description: 'Extra headers JSON' },
  http_wa_inbound_token: { type: 'string', description: 'Inbound webhook token' },

  // Telegram Configuration
  telegram_enabled: {
    type: 'boolean',
    description: 'Enable Telegram'
  },
  telegram_bot_token: {
    type: 'string',
    description: 'Telegram bot token'
  },
  telegram_admin_id: {
    type: 'string',
    pattern: /^\d+$/,
    description: 'Telegram admin ID (numeric)'
  },

  // Tripay Configuration
  tripay_enabled: {
    type: 'boolean',
    description: 'Enable Tripay'
  },
  tripay_api_key: {
    type: 'string',
    minLength: 10,
    description: 'Tripay API key'
  },
  tripay_private_key: {
    type: 'string',
    minLength: 10,
    description: 'Tripay private key'
  },
  tripay_merchant_code: {
    type: 'string',
    minLength: 3,
    description: 'Tripay merchant code'
  },
  tripay_mode: {
    type: 'string',
    enum: ['sandbox', 'live', 'production'],
    description: 'Tripay mode'
  },

  // Midtrans Configuration
  midtrans_enabled: {
    type: 'boolean',
    description: 'Enable Midtrans'
  },
  midtrans_server_key: {
    type: 'string',
    minLength: 10,
    description: 'Midtrans server key'
  },
  midtrans_mode: {
    type: 'string',
    enum: ['sandbox', 'production'],
    description: 'Midtrans mode'
  },

  // Xendit Configuration
  xendit_enabled: {
    type: 'boolean',
    description: 'Enable Xendit'
  },
  xendit_api_key: {
    type: 'string',
    minLength: 10,
    description: 'Xendit API key'
  },

  // Duitku Configuration
  duitku_enabled: {
    type: 'boolean',
    description: 'Enable Duitku'
  },
  duitku_merchant_code: {
    type: 'string',
    minLength: 3,
    description: 'Duitku merchant code'
  },
  duitku_api_key: {
    type: 'string',
    minLength: 10,
    description: 'Duitku API key'
  },
  duitku_mode: {
    type: 'string',
    enum: ['sandbox', 'production'],
    description: 'Duitku mode'
  },

  // Location
  office_lat: {
    type: 'string',
    pattern: /^-?\d+(\.\d+)?$|^$/,
    description: 'Latitude kantor'
  },
  office_lng: {
    type: 'string',
    pattern: /^-?\d+(\.\d+)?$|^$/,
    description: 'Longitude kantor'
  },

  // Other
  default_gateway: {
    type: 'string',
    enum: ['tripay', 'midtrans', 'xendit', 'duitku'],
    description: 'Default payment gateway'
  },
  auto_backup_enabled: {
    type: 'boolean',
    description: 'Enable auto backup'
  },
  login_otp_enabled: {
    type: 'boolean',
    description: 'Enable OTP login'
  },

  // Phase 17 — Mobile push (FCM). Only a FILE PATH is stored; the service
  // account JSON itself lives on disk outside settings.json and is never
  // exposed to any client. Firebase client identifiers below are public by
  // design (they ship in every Android app) and are served to the app at
  // runtime so no google-services.json needs to be baked into the APK.
  fcm_service_account_path: {
    type: 'string',
    minLength: 5,
    maxLength: 512,
    description: 'Path ke file service account Firebase (server-side only)'
  },
  fcm_project_id: {
    type: 'string',
    minLength: 3,
    maxLength: 128,
    pattern: /^[a-z0-9-]+$/,
    description: 'Firebase project id (public client identifier)'
  },
  fcm_app_id: {
    type: 'string',
    minLength: 10,
    maxLength: 128,
    description: 'Firebase Android app id (public client identifier)'
  },
  fcm_api_key: {
    type: 'string',
    minLength: 20,
    maxLength: 128,
    description: 'Firebase Android API key (public client identifier)'
  },
  fcm_sender_id: {
    type: 'string',
    minLength: 6,
    maxLength: 32,
    pattern: /^[0-9]+$/,
    description: 'Firebase messaging sender id (public client identifier)'
  }
};

/**
 * Validate single value
 */
function validateValue(field, value, rule) {
  // Trim string values
  let trimmedValue = value;
  if (typeof value === 'string') {
    trimmedValue = value.trim();
  }

  // Check type
  if (rule.type === 'number') {
    if (typeof trimmedValue !== 'number') return `${field} harus berupa angka`;
    if (rule.min !== undefined && trimmedValue < rule.min) return `${field} minimal ${rule.min}`;
    if (rule.max !== undefined && trimmedValue > rule.max) return `${field} maksimal ${rule.max}`;
  }

  if (rule.type === 'string') {
    if (typeof trimmedValue !== 'string') return `${field} harus berupa string`;
    if (rule.minLength && trimmedValue.length < rule.minLength) return `${field} minimal ${rule.minLength} karakter`;
    if (rule.maxLength && trimmedValue.length > rule.maxLength) return `${field} maksimal ${rule.maxLength} karakter`;
    if (rule.pattern && !rule.pattern.test(trimmedValue)) return `${field} format tidak valid`;
    if (rule.enum && !rule.enum.includes(trimmedValue)) return `${field} harus salah satu dari: ${rule.enum.join(', ')}`;
  }

  if (rule.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${field} harus berupa object`;
  }

  if (rule.type === 'boolean') {
    if (typeof trimmedValue !== 'boolean') return `${field} harus berupa boolean`;
  }

  return null; // Valid
}

/**
 * Validate settings object
 */
function validateSettings(settings) {
  const errors = [];

  Object.keys(settings).forEach(field => {
    const value = settings[field];
    const rule = VALIDATION_RULES[field];

    // Skip jika tidak ada rule (field baru atau optional)
    if (!rule) return;

    // Check required
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field} wajib diisi`);
      return;
    }

    // Skip validation jika value kosong dan tidak required
    if (!rule.required && (value === undefined || value === null || value === '')) {
      return;
    }

    // Validate value
    const error = validateValue(field, value, rule);
    if (error) errors.push(error);
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Get validation rule untuk field
 */
function getFieldRule(field) {
  return VALIDATION_RULES[field] || null;
}

/**
 * Get all validation rules
 */
function getAllRules() {
  return VALIDATION_RULES;
}

module.exports = {
  validateValue,
  validateSettings,
  getFieldRule,
  getAllRules,
  VALIDATION_RULES
};
