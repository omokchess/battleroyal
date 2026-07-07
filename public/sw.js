const CACHE_NAME = 'craftroyale-shell-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/pwa-maskable-512.png',
  '/apple-touch-icon.png',
  '/pwa-icon.svg',
  '/pwa-icon-maskable.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/') || caches.match('/index.html'))
    );
    return;
  }

  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Stale-while-revalidate: serve the cached copy instantly when present, but
  // ALWAYS refetch in the background and update the cache. Fixed-name assets
  // (e.g. the weapon PNGs at /assets/weapons/*.png) keep the same URL across
  // redeploys, so a plain cache-first strategy would pin the old art forever;
  // this makes a redeploy show up on the next load without bumping the version.
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
