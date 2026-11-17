const CACHE_NAME = 'pos-carlos-instant-v7';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css?v=7',
  '/app.js?v=7',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          ASSETS_TO_CACHE.map((url) =>
            fetch(url, { cache: 'reload' }).then((res) => {
              if (res.ok) return cache.put(url, res);
            })
          )
        )
      )
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // No interceptar llamadas a la API o a Neon en el Service Worker
  if (url.pathname.startsWith('/api/') || url.hostname.includes('neon.tech')) {
    return;
  }

  // ESTRATEGIA INSTANTÁNEA (Stale-While-Revalidate):
  // Devuelve inmediatamente la app desde la caché local (0ms de espera, sin pantalla de carga de Render)
  // y actualiza silenciosamente en segundo plano cuando Render despierte.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse =
        (await cache.match(req)) ||
        (req.mode === 'navigate' ? await cache.match('/index.html') : null);

      const networkFetch = fetch(req)
        .then((networkRes) => {
          // Solo actualizar caché si es una respuesta válida de nuestra app (no página de espera 502/503 de Render)
          if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
            cache.put(req, networkRes.clone());
          }
          return networkRes;
        })
        .catch(() => null);

      // Si ya tenemos la app en caché, mostrarla AL INSTANTE sin esperar a Render
      if (cachedResponse) {
        event.waitUntil(networkFetch);
        return cachedResponse;
      }

      // Primera visita sin caché
      const netRes = await networkFetch;
      return netRes || (await cache.match('/index.html'));
    })
  );
});
