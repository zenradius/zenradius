const CACHE_NAME = 'zenradius-pwa-v8';
const PRECACHE_URLS = [
  '/css/style.css',
  '/css/unified.css',
  '/img/logo.png',
  '/img/icon.png',
  '/img/hero.png'
];

const ADMIN_CACHE_URLS = [
  '/css/style.css',
  '/js/admin.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {}),
      caches.open(CACHE_NAME + '-admin').then((cache) => cache.addAll(ADMIN_CACHE_URLS)).catch(() => {})
    ])
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.map((k) => (k.startsWith('zenradius-pwa-') ? null : caches.delete(k))))
      ),
      self.clients.claim()
    ])
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    return new Response('Offline - Resource tidak tersedia', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function networkFirst(request, fallbackUrl) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('Offline - Koneksi internet diperlukan', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// Serve cache immediately but refresh it in the background so CSS/asset fixes
// (e.g. layout/menu changes) reach installed PWA users without waiting for a manual cache clear.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return cached || (await fetchPromise) || new Response('Offline - Resource tidak tersedia', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// Handle admin panel with better offline support
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Allow normal browser navigation for admin pages.
  // Use /admin as the app entry so a logged-in user opens the dashboard directly;
  // if not logged in, the server redirects to /admin/login.
  if (req.mode === 'navigate') {
    if (path === '/admin' || path.startsWith('/admin/')) {
      event.respondWith(
        fetch(req).catch(async () => {
          const fallback = await caches.match('/admin/login') || await caches.match('/admin');
          if (fallback) return fallback;

          return new Response('Offline - Admin login unavailable', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        })
      );
      return;
    }

    event.respondWith(
      fetch(req).catch(async () => {
        const fallback = await caches.match('/admin/login');
        if (fallback) return fallback;

        return new Response('Offline - Halaman tidak tersedia', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      })
    );
    return;
  }

  if (path.startsWith('/customer/')) {
    event.respondWith(networkFirst(req, '/customer/login'));
    return;
  }

  // CSS - stale-while-revalidate so style/layout fixes reach devices promptly
  if (path.startsWith('/css/')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Brand images & manifests - stale-while-revalidate so logo/icon changes
  // uploaded from admin panel reach installed PWA users without clearing cache.
  if (path === '/img/logo.png' || path === '/img/icon.png' ||
      path === '/manifest.webmanifest' || path === '/manifest-admin.webmanifest') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Other static assets - cache first
  if (path.startsWith('/img/') || path.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // API dan hal lainnya - network first dengan fallback
  event.respondWith(networkFirst(req));
});
