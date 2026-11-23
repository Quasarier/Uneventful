const CACHE_NAME = 'uneventful-static-v2';
const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [OFFLINE_URL, '/offline.css', '/icons/icon.svg'];

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

self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data.json();
      } catch {
        return;
      }
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Object.keys(payload).length !== 3 ||
        payload.title !== 'CampusPulse update' ||
        typeof payload.eventName !== 'string' ||
        payload.eventName.length === 0 ||
        payload.eventName.length > 200 ||
        typeof payload.link !== 'string'
      ) {
        return;
      }
      const target = new URL(payload.link, self.location.origin);
      if (
        target.origin !== self.location.origin ||
        (target.pathname !== '/events' && !/^\/events\/[0-9a-f-]{36}$/.test(target.pathname)) ||
        target.search ||
        target.hash
      ) {
        return;
      }
      await self.registration.showNotification(payload.title, {
        body: payload.eventName,
        data: { link: target.pathname },
        tag: `campuspulse:${target.pathname}`,
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link;
  if (typeof link !== 'string') {
    return;
  }
  const target = new URL(link, self.location.origin);
  if (target.origin !== self.location.origin || !target.pathname.startsWith('/events')) {
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        return existing.focus().then(() => existing.navigate(target.toString()));
      }
      return self.clients.openWindow(target.toString());
    }),
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

  if (url.pathname === '/offline.css' || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(request).then((cached) => cached || fetch(request))),
    );
  }
});
