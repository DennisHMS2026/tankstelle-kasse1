/* Service Worker – generiert von tools/build-pwa.mjs. Nicht von Hand ändern. */
const VERSION = '988e5bc30dbd';
const CACHE = 'tankstelle-pos-' + VERSION;
const ASSETS = [
 "./css/pos.css",
 "./icons/apple-touch-icon.png",
 "./icons/icon-192.png",
 "./icons/icon-512-maskable.png",
 "./icons/icon-512.png",
 "./index.html",
 "./js/core/automat.js",
 "./js/core/cart.js",
 "./js/core/ean.js",
 "./js/core/fuel.js",
 "./js/core/ledger.js",
 "./js/core/money.js",
 "./js/core/pumps.js",
 "./js/core/rules.js",
 "./js/core/training.js",
 "./js/data/reports.js",
 "./js/data/seed.js",
 "./js/data/store.js",
 "./js/hw/printer.js",
 "./js/hw/scanner.js",
 "./js/hw/sound.js",
 "./js/ui/admin.js",
 "./js/ui/app.js",
 "./js/ui/automat-view.js",
 "./js/ui/board.js",
 "./js/ui/pos.js",
 "./js/ui/pumps-view.js",
 "./js/ui/pwa.js",
 "./js/ui/shop-view.js",
 "./js/ui/ui.js",
 "./manifest.webmanifest"
];

// Installation: alle Dateien in den Cache dieser Version. Schlägt ein Download fehl, bleibt die alte Version aktiv.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

// Aktivierung: alte Versionen entfernen.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('tankstelle-pos-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// Die App entscheidet, wann die neue Version übernommen wird (nicht mitten in einem Tankvorgang).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'STATUS' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION, cache: CACHE, assets: ASSETS });
  }
});

// Nur eigene Dateien. Keine externen Ressourcen. Cache zuerst, dann Netz.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const page = await cache.match('./index.html');
      if (page) return page;
    }
    try {
      return await fetch(req);
    } catch (err) {
      return new Response('Offline und nicht im Cache: ' + url.pathname, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
