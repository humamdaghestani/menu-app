const CACHE = 'pos-v3';
const OFFLINE = '/offline.html';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(OFFLINE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  // API calls: skip (handled by pos-offline.js with its own queue)
  if (url.pathname.startsWith('/pos/api/')) return;

  // POS pages & static assets: network-first, cache on success, serve cache when offline
  if (url.pathname.startsWith('/pos') || url.pathname.match(/\.(js|css|png|jpg|ico|webp)$/)) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(request);
          return hit || caches.match(OFFLINE);
        })
    );
    return;
  }

  e.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
});
