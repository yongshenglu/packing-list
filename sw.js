const VER = 'pl-v4';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VER).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter(k => k.startsWith('pl-') && k !== VER);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    if (old.length) {
      const cs = await self.clients.matchAll();
      cs.forEach(c => c.postMessage({ type: 'updated' }));
    }
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => { const cp = r.clone(); caches.open(VER).then(c => c.put('./', cp)); return r; })
        .catch(() => caches.match('./'))
    );
    return;
  }

  e.respondWith((async () => {
    const cache = await caches.open(VER);
    const cached = await cache.match(req);
    const net = fetch(req).then(r => {
      if (r && r.ok) cache.put(req, r.clone());
      return r;
    }).catch(() => null);
    return cached || (await net) || Response.error();
  })());
});
