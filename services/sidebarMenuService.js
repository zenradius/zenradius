const { getSetting, getSettings, saveSettings } = require('../config/settingsManager');
const { getAppSetting, saveAppSetting } = require('../config/database');

const SETTINGS_KEY = 'sidebar_menu_states';
const STATE_VISIBLE = 'visible';
const STATE_HIDDEN = 'hidden';
const STATE_LOCKED = 'locked';
const VALID_STATES = new Set([STATE_VISIBLE, STATE_HIDDEN, STATE_LOCKED]);
const PROTECTED_MENU_KEYS = new Set([
  'dashboard', 'settings', 'sidebar_settings',
  'tech_dashboard', 'agent_home', 'collector_dashboard'
]);

const MENU_DEFINITIONS = [
  { key: 'dashboard', section: 'main', href: '/admin', icon: 'bi bi-speedometer2', labelKey: 'admin.nav.dashboard', labelDefault: 'Dashboard', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['dashboard'] },
  { key: 'mikrotik', section: 'main', href: '/admin/mikrotik', icon: 'bi bi-router', labelKey: 'admin.nav.mikrotik', labelDefault: 'MikroTik', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['mikrotik'] },
  { key: 'acs_pro', section: 'main', href: '/admin/acs', icon: 'bi bi-hdd-network', labelKey: 'admin.nav.acs_pro', labelDefault: 'GenieACS Pro', roles: ['admin'], activePages: ['acs_pro'] },
  { key: 'onu_provision', section: 'main', href: '/admin/onu-provision', icon: 'bi bi-hdd-network-fill', labelKey: 'admin.nav.onu_provision', labelDefault: 'ONU Provision', roles: ['admin'], activePages: ['onu_provision'] },
  { key: 'olts', section: 'main', href: '/admin/olts', icon: 'bi bi-hdd-fill', labelKey: 'admin.nav.olt_management', labelDefault: 'Manajemen OLT', roles: ['admin'], activePages: ['olts'] },
  { key: 'radius_server', section: 'main', href: '/admin/radius-settings', icon: 'bi bi-broadcast', labelKey: 'admin.nav.radius_server', labelDefault: 'RADIUS Server', roles: ['admin', 'cashier'], activePages: ['radius_settings'] },
  { key: 'whatsapp', section: 'main', href: '/admin/whatsapp', icon: 'bi bi-whatsapp', labelKey: 'admin.nav.whatsapp', labelDefault: 'WhatsApp', roles: ['admin', 'cashier'], activePages: ['whatsapp'] },
  { key: 'broadcast', section: 'main', href: '/admin/whatsapp/broadcast', icon: 'bi bi-megaphone', labelKey: 'admin.nav.broadcast_wa', labelDefault: 'Broadcast WA', roles: ['admin', 'cashier'], activePages: ['broadcast'] },
  { key: 'whatsapp_live_chat', section: 'main', href: '/admin/whatsapp/live-chat', icon: 'bi bi-chat-dots-fill', labelKey: 'admin.nav.whatsapp_live_chat', labelDefault: 'Live Chat WA', roles: ['admin', 'cashier'], activePages: ['whatsapp_live_chat'] },
  { key: 'telegram_bot', section: 'main', href: '/admin/telegram-bot', icon: 'bi bi-telegram', labelKey: 'admin.nav.telegram_bot', labelDefault: 'Telegram Bot', roles: ['admin'], activePages: ['telegram_bot'] },
  { key: 'areas', section: 'main', href: '/admin/areas', icon: 'bi bi-geo-alt', labelKey: 'admin.nav.areas', labelDefault: 'Area Layanan', roles: ['admin', 'cashier'], activePages: ['areas'] },
  { key: 'map', section: 'main', href: '/admin/map', icon: 'bi bi-map', labelKey: 'admin.nav.network_map', labelDefault: 'Peta Jaringan', roles: ['admin', 'cashier'], activePages: ['map'] },
  { key: 'promo_slides', section: 'service', href: '/admin/promo-slides', icon: 'bi bi-images', labelKey: 'admin.nav.promo_slides', labelDefault: 'Promo Slides', roles: ['admin'], activePages: ['promo_slides'] },

  { key: 'customers', section: 'billing', href: '/admin/customers', icon: 'bi bi-people', labelKey: 'admin.nav.customers', labelDefault: 'Pelanggan', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['customers'] },
  { key: 'packages', section: 'billing', href: '/admin/packages', icon: 'bi bi-box-seam', labelKey: 'admin.nav.internet_packages', labelDefault: 'Paket Internet', roles: ['admin', 'cashier'], activePages: ['packages'] },
  { key: 'voucher_packages', section: 'billing', href: '/admin/vouchers/packages', icon: 'bi bi-ticket-detailed', labelKey: 'admin.nav.voucher_packages', labelDefault: 'Paket Voucher', roles: ['admin', 'cashier'], activePages: ['voucher_packages'] },
  { key: 'billing', section: 'billing', href: '/admin/billing', icon: 'bi bi-receipt', labelKey: 'admin.nav.invoices', labelDefault: 'Tagihan', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['billing'] },

  { key: 'tickets', section: 'service', href: '/admin/tickets', icon: 'bi bi-headset', labelKey: 'admin.nav.customer_tickets', labelDefault: 'Tiket Customer', roles: ['admin', 'cashier'], activePages: ['tickets'] },
  { key: 'collector_payments', section: 'service', href: '/admin/collector-payments', icon: 'bi bi-check2-square', labelKey: 'admin.nav.collector_payments', labelDefault: 'Approval Kolektor', roles: ['admin', 'cashier'], activePages: ['collector_payments'] },
  { key: 'inventory', section: 'service', href: '/admin/inventory', icon: 'bi bi-boxes', labelKey: 'admin.nav.inventory', labelDefault: 'Inventaris (Stok)', roles: ['admin', 'cashier'], activePages: ['inventory'] },
  { key: 'digiflazz', section: 'service', href: '/admin/digiflazz', icon: 'bi bi-phone', labelKey: 'admin.nav.digiflazz', labelDefault: 'Digiflazz', roles: ['admin'], activePages: ['digiflazz'] },

  { key: 'reports', section: 'finance', href: '/admin/reports', icon: 'bi bi-bar-chart-line', labelKey: 'admin.nav.finance_report', labelDefault: 'Laporan Keuangan', roles: ['admin', 'cashier'], activePages: ['reports'] },
  { key: 'cashiers_reports', section: 'finance', href: '/admin/cashiers/reports', icon: 'bi bi-journal-text', labelKey: 'admin.nav.cashiers_reports', labelDefault: 'Laporan Kasir', roles: ['admin', 'cashier'], activePages: ['cashiers_reports'] },
  { key: 'payroll', section: 'finance', href: '/admin/payroll', icon: 'bi bi-wallet2', labelKey: 'admin.nav.payroll', labelDefault: 'Gaji & Payroll', roles: ['admin'], activePages: ['payroll'] },

  { key: 'attendance', section: 'user_management', href: '/admin/attendance', icon: 'bi bi-calendar-check', labelKey: 'admin.nav.attendance', labelDefault: 'Absensi Karyawan', roles: ['admin', 'cashier'], activePages: ['attendance'] },

  { key: 'cash_in', section: 'finance', href: '/admin/finance/cash-in', icon: 'bi bi-cash-stack', labelKey: 'admin.nav.cash_in', labelDefault: 'Kas Masuk', roles: ['admin', 'cashier'], activePages: ['cash_in'] },
  { key: 'expenses', section: 'finance', href: '/admin/finance/expenses', icon: 'bi bi-wallet2', labelKey: 'admin.nav.expenses', labelDefault: 'Pengeluaran', roles: ['admin', 'cashier'], activePages: ['expenses'] },
  { key: 'expense_categories', section: 'finance', href: '/admin/finance/expense-categories', icon: 'bi bi-tags', labelKey: 'admin.nav.expense_categories', labelDefault: 'Kategori Pengeluaran', roles: ['admin'], activePages: ['expense_categories'] },

  { key: 'cashier_attendance', section: 'cashier', href: '/admin/cashiers/attendance', icon: 'bi bi-calendar-check', labelKey: 'admin.nav.cashier_attendance', labelDefault: 'Absensi Saya', roles: ['cashier'], activePages: ['cashier_attendance'] },

  { key: 'technicians', section: 'user_management', href: '/admin/technicians', icon: 'bi bi-person-gear', labelKey: 'admin.nav.technicians', labelDefault: 'Teknisi', roles: ['admin'], activePages: ['technicians'] },
  { key: 'cashiers', section: 'user_management', href: '/admin/cashiers', icon: 'bi bi-person-vcard', labelKey: 'admin.nav.cashiers', labelDefault: 'Kasir', roles: ['admin'], activePages: ['cashiers'] },
  { key: 'collectors', section: 'user_management', href: '/admin/collectors', icon: 'bi bi-person-badge', labelKey: 'admin.nav.collectors', labelDefault: 'Kolektor', roles: ['admin'], activePages: ['collectors'] },
  { key: 'agents', section: 'user_management', href: '/admin/agents', icon: 'bi bi-person-badge', labelKey: 'admin.nav.agents', labelDefault: 'Reseller', roles: ['admin', 'cashier'], activePages: ['agents'] },
  { key: 'agents_reports', section: 'user_management', href: '/admin/agents/reports', icon: 'bi bi-journal-text', labelKey: 'admin.nav.agent_reports', labelDefault: 'Laporan Reseller', roles: ['admin'], activePages: ['agents_reports'] },
  { key: 'user_management', section: 'user_management', href: '/admin/users', icon: 'bi bi-person-lines-fill', labelKey: 'admin.nav.user_management', labelDefault: 'Akses Role', roles: ['admin'], activePages: ['user_management'] },

  { key: 'payment_gateway', section: 'system', href: '/admin/payment-gateway', icon: 'bi bi-credit-card-2-front', labelKey: 'admin.nav.payment_gateway', labelDefault: 'Payment Gateway', roles: ['admin'], activePages: ['payment_gateway'] },
  { key: 'ewallet_logs', section: 'system', href: '/admin/ewallet-logs', icon: 'bi bi-wallet2', labelKey: 'admin.settings.ewallet_logs.title', labelDefault: 'Notifikasi E-Wallet', roles: ['admin'], activePages: ['ewallet_logs'] },
  { key: 'backup', section: 'system', href: '/admin/backup', icon: 'bi bi-hdd-stack', labelKey: 'admin.nav.backup', labelDefault: 'Backup & Recovery', roles: ['admin'], activePages: ['backup'] },
  { key: 'sidebar_settings', section: 'system', href: '/admin/sidebar-settings', icon: 'bi bi-layout-sidebar-inset', labelKey: 'admin.nav.sidebar_settings', labelDefault: 'Pengaturan Sidebar', roles: ['admin'], activePages: ['sidebar_settings'] },
  { key: 'monitoring', section: 'system', href: '/admin/monitoring', icon: 'bi bi-activity', labelKey: 'admin.nav.monitoring', labelDefault: 'Monitoring Sistem', roles: ['admin'], activePages: ['monitoring'] },
  { key: 'audit_logs', section: 'system', href: '/admin/audit-logs', icon: 'bi bi-shield-lock', labelKey: 'admin.nav.audit_logs', labelDefault: 'Log Aktivitas', roles: ['admin'], activePages: ['audit_logs'] },
  { key: 'settings', section: 'system', href: '/admin/settings', icon: 'bi bi-gear', labelKey: 'admin.nav.settings', labelDefault: 'Pengaturan', roles: ['admin'], activePages: ['settings'] },
  { key: 'update', section: 'system', href: '/admin/update', icon: 'bi bi-cloud-arrow-down', labelKey: 'admin.nav.update', labelDefault: 'Update GitHub', roles: ['admin'], activePages: ['update'] },

  { key: 'tech_dashboard', section: 'tech', href: '/tech', icon: 'bi bi-briefcase-fill', labelKey: 'tech.nav.my_tasks', labelDefault: 'Tugas Saya', roles: ['teknisi'], bottomNav: true, activePages: ['dashboard'] },
  { key: 'tech_pool', section: 'tech', href: '/tech/pool', icon: 'bi bi-inbox-fill', labelKey: 'tech.nav.new_tickets', labelDefault: 'Tiket Baru', roles: ['teknisi'], bottomNav: true, activePages: ['pool'] },
  { key: 'tech_attendance', section: 'tech', href: '/tech/attendance', icon: 'bi bi-calendar-check-fill', labelKey: 'tech.nav.attendance', labelDefault: 'Absensi', roles: ['teknisi'], bottomNav: true, activePages: ['attendance'] },
  { key: 'tech_map', section: 'tech', href: '/tech/map', icon: 'bi bi-map-fill', labelKey: 'tech.nav.map', labelDefault: 'Peta', roles: ['teknisi'], bottomNav: true, activePages: ['map'] },
  { key: 'tech_monitoring', section: 'tech', href: '/tech/monitoring', icon: 'bi bi-display-fill', labelKey: 'tech.nav.monitor', labelDefault: 'Monitor', roles: ['teknisi'], bottomNav: true, activePages: ['monitoring'] },
  { key: 'tech_create_customer', section: 'tech', href: '/tech/customers/new', icon: 'bi bi-person-plus-fill', labelKey: 'tech.new_customer', labelDefault: 'Tambah Pelanggan', roles: ['teknisi'], bottomNav: false, activePages: ['create_customer'] },

  { key: 'agent_home', section: 'agent', href: '/agent#section-top', icon: 'bi bi-house', labelKey: 'agent.nav.home', labelDefault: 'Beranda', roles: ['reseller'], bottomNav: true, activePages: ['top'] },
  { key: 'agent_billing', section: 'agent', href: '/agent#section-bill', icon: 'bi bi-receipt', labelKey: 'agent.nav.billing', labelDefault: 'Tagihan', roles: ['reseller'], bottomNav: true, activePages: ['bill'] },
  { key: 'agent_voucher', section: 'agent', href: '/agent#section-voucher', icon: 'bi bi-ticket-perforated', labelKey: 'agent.nav.voucher', labelDefault: 'Voucher', roles: ['reseller'], bottomNav: true, activePages: ['voucher'] },
  { key: 'agent_pulsa', section: 'agent', href: '/agent#section-pulsa', icon: 'bi bi-phone', labelKey: 'agent.nav.pulsa', labelDefault: 'Pulsa', roles: ['reseller'], bottomNav: true, activePages: ['pulsa'] },
  { key: 'agent_history', section: 'agent', href: '/agent#section-history', icon: 'bi bi-clock-history', labelKey: 'agent.nav.history', labelDefault: 'Riwayat', roles: ['reseller'], bottomNav: true, activePages: ['history'] },

  { key: 'collector_dashboard', section: 'collector', href: '/collector', icon: 'bi bi-grid-3x3-gap', labelKey: 'collector.nav.dashboard', labelDefault: 'Dashboard', roles: ['kolektor'], bottomNav: true, activePages: ['dashboard'] },
  { key: 'collector_attendance', section: 'collector', href: '/collector/attendance', icon: 'bi bi-calendar-check-fill', labelKey: 'collector.nav.attendance', labelDefault: 'Absensi', roles: ['kolektor'], bottomNav: true, activePages: ['attendance'] }
];

const DEFAULT_MENU_STATES = {
  dashboard: STATE_VISIBLE,
  mikrotik: STATE_VISIBLE,
  radius_server: STATE_VISIBLE,
  map: STATE_VISIBLE,
  acs_pro: STATE_VISIBLE,
  onu_provision: STATE_VISIBLE,
  olts: STATE_HIDDEN,
  whatsapp: STATE_VISIBLE,
  broadcast: STATE_VISIBLE,
  whatsapp_live_chat: STATE_VISIBLE,
  telegram_bot: STATE_VISIBLE,
  promo_slides: STATE_VISIBLE,
  customers: STATE_VISIBLE,
  packages: STATE_VISIBLE,
  voucher_packages: STATE_VISIBLE,
  billing: STATE_VISIBLE,
  digiflazz: STATE_VISIBLE,
  reports: STATE_VISIBLE,
  cashiers_reports: STATE_VISIBLE,
  collector_payments: STATE_VISIBLE,
  tickets: STATE_VISIBLE,
  inventory: STATE_VISIBLE,
  attendance: STATE_VISIBLE,
  payroll: STATE_VISIBLE,
  cash_in: STATE_VISIBLE,
  expenses: STATE_VISIBLE,
  expense_categories: STATE_VISIBLE,
  payment_gateway: STATE_VISIBLE,
  cashier_attendance: STATE_VISIBLE,
  technicians: STATE_VISIBLE,
  cashiers: STATE_VISIBLE,
  collectors: STATE_VISIBLE,
  areas: STATE_VISIBLE,
  agents: STATE_VISIBLE,
  agents_reports: STATE_VISIBLE,
  user_management: STATE_VISIBLE,
  sidebar_settings: STATE_VISIBLE,
  update: STATE_VISIBLE,
  settings: STATE_VISIBLE,
  ewallet_logs: STATE_VISIBLE,
  backup: STATE_VISIBLE,
  monitoring: STATE_VISIBLE,
  audit_logs: STATE_VISIBLE,

  tech_dashboard: STATE_VISIBLE,
  tech_pool: STATE_VISIBLE,
  tech_attendance: STATE_VISIBLE,
  tech_map: STATE_VISIBLE,
  tech_monitoring: STATE_VISIBLE,
  tech_create_customer: STATE_VISIBLE,

  agent_home: STATE_VISIBLE,
  agent_billing: STATE_VISIBLE,
  agent_voucher: STATE_VISIBLE,
  agent_pulsa: STATE_VISIBLE,
  agent_history: STATE_VISIBLE,

  collector_dashboard: STATE_VISIBLE,
  collector_attendance: STATE_VISIBLE
};

const SECTION_DEFINITIONS = [
  { key: 'main', labelKey: 'admin.section.main', labelDefault: 'UTAMA' },
  { key: 'billing', labelKey: 'admin.section.billing', labelDefault: 'BILLING' },
  { key: 'finance', labelKey: 'admin.section.finance', labelDefault: 'KEUANGAN' },
  { key: 'service', labelKey: 'admin.section.service', labelDefault: 'LAYANAN' },
  { key: 'cashier', labelKey: 'admin.section.cashier', labelDefault: 'KASIR' },
  { key: 'user_management', labelKey: 'admin.section.user_management', labelDefault: 'MANAJEMEN USER' },
  { key: 'system', labelKey: 'admin.section.system', labelDefault: 'SISTEM' },
  { key: 'tech', labelKey: 'admin.section.tech', labelDefault: 'PORTAL TEKNISI' },
  { key: 'agent', labelKey: 'admin.section.agent', labelDefault: 'PORTAL RESELLER' },
  { key: 'collector', labelKey: 'admin.section.collector', labelDefault: 'PORTAL KOLEKTOR' }
];

function normalizeState(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_STATES.has(normalized) ? normalized : STATE_VISIBLE;
}

function getStoredMenuStates() {
  
  let raw = getAppSetting(SETTINGS_KEY, null);

  if (raw === null) {
    raw = getSetting(SETTINGS_KEY, {});
    
    if (Object.keys(raw).length > 0) {
      saveAppSetting(SETTINGS_KEY, raw);
    }
  }

  const stateMap = {};

  for (const menu of MENU_DEFINITIONS) {
    const defaultState = DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
    let storedState = raw && raw[menu.key] ? raw[menu.key] : defaultState;
    
    const normalized = normalizeState(storedState);
    stateMap[menu.key] = normalized;
  }
  return stateMap;
}

function isMasterAdminUser(session) {
  return Boolean(session?.isMasterAdmin);
}

function validateDonationActivationCode(code) {
  try {
    const db = require('../config/database');
    const order = db.prepare('SELECT id, status, activation_code_used FROM public_donation_orders WHERE activation_code = ? LIMIT 1').get(code);
    if (!order) return null;
    if (order.status !== 'paid') return null;
    if (order.activation_code_used) return null;
    return order;
  } catch (e) {
    return null;
  }
}

function markDonationCodeUsed(code) {
  try {
    const db = require('../config/database');
    db.prepare('UPDATE public_donation_orders SET activation_code_used = 1 WHERE activation_code = ?').run(code);
  } catch (e) {
    
  }
}

function saveMenuStates(stateMap) {
  
  saveAppSetting(SETTINGS_KEY, sanitizeMenuStates(stateMap));
  return true;
}

function sanitizeMenuStates(input, options = {}) {
  const allowLocked = options.allowLocked !== false;
  const currentStates = options.currentStates || {};
  const clean = {};
  for (const menu of MENU_DEFINITIONS) {
    const defaultState = DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
    let state = input && input[menu.key] ? input[menu.key] : defaultState;

    state = normalizeState(state);
    if (!allowLocked && state === STATE_LOCKED) {
      state = currentStates[menu.key] === STATE_LOCKED ? STATE_LOCKED : STATE_VISIBLE;
    }
    clean[menu.key] = PROTECTED_MENU_KEYS.has(menu.key) && state === STATE_LOCKED
      ? STATE_VISIBLE
      : state;
  }
  return clean;
}

function getSessionRole(session) {
  
  const explicit = String(session?.role || '').trim().toLowerCase();
  if (['admin', 'customer_service', 'kolektor', 'teknisi', 'reseller'].includes(explicit)) {
    return explicit === 'customer_service' ? 'cashier' : explicit;
  }

  const legacyRole = String(session?.userRole || '').trim().toLowerCase();
  if (legacyRole === 'admin' || legacyRole === 'cashier') return legacyRole;
  if (session?.isAdmin && !session?.isCashier) return 'admin';
  if (session?.isCashier) return 'cashier';
  if (session?.isTechnician) return 'teknisi';
  if (session?.isAgent) return 'reseller';
  if (session?.isCollector) return 'kolektor';
  return null;
}

function isMenuAllowedForSession(menu, session) {
  const role = getSessionRole(session);
  const roles = Array.isArray(menu.roles) ? menu.roles : ['admin'];

  if (menu.masterOnly && !isMasterAdminUser(session)) return false;

  if (!role || !roles.includes(role)) return false;

  // Per-user override (checkbox permissions dari Akses Role)
  if (role !== 'admin') {
    try {
      const userPermSvc = require('./userPermissionService');
      const override = userPermSvc.checkSessionMenuOverride(session, menu.key);
      if (override !== null) return override;
    } catch (e) {}
  }

  return true;
}

/** Daftar menu (dikelompokkan per section) yang bisa diberikan ke role tertentu. */
function getAssignableMenusForRole(role) {
  const normalized = role === 'customer_service' ? 'cashier' : String(role || '');
  return SECTION_DEFINITIONS.map((section) => ({
    ...section,
    items: MENU_DEFINITIONS
      .filter((m) => m.section === section.key && Array.isArray(m.roles) && m.roles.includes(normalized))
      .map((m) => ({ key: m.key, label: m.labelDefault, labelKey: m.labelKey, icon: m.icon }))
  })).filter((s) => s.items.length > 0);
}

function enrichMenu(menu, states) {
  const state = states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
  const hidden = state === STATE_HIDDEN;

  const locked = false;

  return {
    ...menu,
    state: state === STATE_LOCKED ? STATE_VISIBLE : state,
    locked,
    hidden,
    hrefResolved: menu.href,
    lockedMessage: ''
  };
}

function getSidebarSections(session) {
  const states = getStoredMenuStates();
  return SECTION_DEFINITIONS.map((section) => {
    const items = MENU_DEFINITIONS
      .filter((menu) => menu.section === section.key)
      .filter((menu) => isMenuAllowedForSession(menu, session))
      .map((menu) => enrichMenu(menu, states))
      .filter((menu) => !menu.hidden);

    return {
      ...section,
      items
    };
  }).filter((section) => section.items.length > 0);
}

function getBottomNavItems(session) {
  const states = getStoredMenuStates();
  return MENU_DEFINITIONS
    .filter((menu) => menu.bottomNav)
    .filter((menu) => isMenuAllowedForSession(menu, session))
    .map((menu) => enrichMenu(menu, states))
    .filter((menu) => !menu.hidden);
}

function getConfigMenus() {
  const states = getStoredMenuStates();
  const ROLE_LABELS = {
    admin: 'Admin',
    cashier: 'Kasir',
    kolektor: 'Kolektor',
    teknisi: 'Teknisi',
    reseller: 'Reseller'
  };
  return MENU_DEFINITIONS.map((menu) => {
    const section = SECTION_DEFINITIONS.find((s) => s.key === menu.section);
    const state = states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
    return {
      ...menu,
      state,
      defaultState: DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE,
      locked: state === STATE_LOCKED,
      canLock: !PROTECTED_MENU_KEYS.has(menu.key),
      roleLabel: menu.roles.map((r) => ROLE_LABELS[r] || r).join(' & '),
      sectionLabel: section?.labelDefault || menu.section,
      sectionLabelKey: section?.labelKey || ''
    };
  });
}

function getMenuDefinition(key) {
  return MENU_DEFINITIONS.find((menu) => menu.key === key) || null;
}

function evaluateMenuAccess(menuKey, session) {
  const menu = getMenuDefinition(menuKey);
  if (!menu) {
    return { allowed: true, state: STATE_VISIBLE, menu: null };
  }

  if (!isMenuAllowedForSession(menu, session)) {
    return { allowed: false, state: 'forbidden', menu, reason: 'forbidden' };
  }

  const states = getStoredMenuStates();
  const state = states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
  if (state === STATE_HIDDEN) {
    return { allowed: false, state, menu, reason: 'hidden' };
  }

  return { allowed: true, state: STATE_VISIBLE, menu, reason: null };
}

module.exports = {
  STATE_VISIBLE,
  STATE_HIDDEN,
  STATE_LOCKED,
  MENU_DEFINITIONS,
  DEFAULT_MENU_STATES,
  getSidebarSections,
  getBottomNavItems,
  getConfigMenus,
  getAssignableMenusForRole,
  getMenuDefinition,
  getStoredMenuStates,
  sanitizeMenuStates,
  saveMenuStates,
  evaluateMenuAccess,
  isMasterAdminUser
};
