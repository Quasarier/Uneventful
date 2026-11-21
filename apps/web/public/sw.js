const CACHE_NAME = 'uneventful-static-v2';
const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [OFFLINE_URL, '/icons/icon.svg'];

async function precachePublicAsset(cache, path) {
  const request = new Request(new URL(path, self.location.origin), {
    credentials: 'omit',
    method: 'GET',
  });
  if (request.headers.has('authorization')) {
    return;
  }

  const response = await fetch(request);
  if (
    !response.ok ||
    response.headers.has('set-cookie') ||
    /\bno-store\b/i.test(response.headers.get('cache-control') || '')
  ) {
    return;
  }
  await cache.put(request, response.clone());
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const path of PRECACHE_URLS) {
        await precachePublicAsset(cache, path);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('uneventful-static-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'uneventful:logout') {
    return;
  }
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('uneventful-')).map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    request.headers.has('authorization') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  if (url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(request).then((cached) => cached || fetch(request))),
    );
  }
});
