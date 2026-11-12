// Service worker: la app funciona sin conexión y recibe audio "compartido" desde otras apps.
const VERSION = 'v9';
const CACHE = `localmusic-${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/library.js', 'js/player.js', 'js/db.js', 'js/metadata.js', 'js/icons.js', 'js/stats.js', 'js/debug.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('localmusic-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // "Compartir" archivos de audio con LocalMusic (Android)
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('audio');
      const cache = await caches.open('localmusic-share');
      await Promise.all(files.map((f, i) => cache.put(`share/${i}`, new Response(f, { headers: { 'x-name': encodeURIComponent(f.name), 'content-type': f.type } }))));
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;

  // Red primero para la app (así recibes actualizaciones), caché si no hay conexión
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Sin la caché HTTP del navegador: así siempre llega la última versión publicada
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      return hit || cache.match('index.html');
    }
  })());
});
