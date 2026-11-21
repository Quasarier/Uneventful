import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const serviceWorkerSource = readFileSync('public/sw.js', 'utf8');

interface WorkerEvent {
  data?: { type?: string };
  request?: Request;
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (response: Promise<Response>) => void;
}

type WorkerHandler = (event: WorkerEvent) => void;

function createWorker(
  fetchAsset: (request: Request) => Promise<Response> = vi.fn(async () => new Response('asset')),
  initialCaches = ['uneventful-static-v1', 'unrelated-cache'],
) {
  const handlers = new Map<string, WorkerHandler>();
  const cacheWrites: Array<{ path: string; response: Response }> = [];
  const deletedCaches: string[] = [];
  const cache = {
    match: vi.fn(async () => undefined as Response | undefined),
    put: vi.fn(async (request: Request, response: Response) => {
      cacheWrites.push({ path: new URL(request.url).pathname, response });
    }),
  };
  const cacheNames = new Set(initialCaches);
  const cachesApi = {
    delete: vi.fn(async (name: string) => {
      deletedCaches.push(name);
      return cacheNames.delete(name);
    }),
    keys: vi.fn(async () => [...cacheNames]),
    match: vi.fn(async () => undefined as Response | undefined),
    open: vi.fn(async () => cache),
  };
  const self = {
    addEventListener: (name: string, handler: WorkerHandler) => handlers.set(name, handler),
    clients: { claim: vi.fn(async () => undefined) },
    location: { origin: 'https://uneventful.test' },
    skipWaiting: vi.fn(async () => undefined),
  };
  runInNewContext(serviceWorkerSource, {
    Request,
    Response,
    URL,
    caches: cachesApi,
    fetch: fetchAsset,
    Promise,
    self,
  });

  return { cache, cacheNames, cacheWrites, cachesApi, deletedCaches, fetchAsset, handlers, self };
}

function extendableEvent(properties: Partial<WorkerEvent> = {}) {
  let pending: Promise<unknown> | undefined;
  let response: Promise<Response> | undefined;
  return {
    event: {
      data: properties.data,
      request: properties.request,
      respondWith: (next: Promise<Response>) => {
        response = next;
      },
      waitUntil: (next: Promise<unknown>) => {
        pending = next;
      },
    } satisfies WorkerEvent,
    pending: () => pending,
    response: () => response,
  };
}

describe('service worker cache policy', () => {
  it('precaches only the offline page and public static icon', async () => {
    const worker = createWorker();
    const event = extendableEvent();

    worker.handlers.get('install')?.(event.event);
    await event.pending();

    expect(worker.cacheWrites.map(({ path }) => path).sort()).toEqual([
      '/icons/icon.svg',
      '/offline.html',
    ]);
    expect(worker.fetchAsset).toHaveBeenCalledTimes(2);
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('does not cache a precache response carrying Set-Cookie or no-store', async () => {
    const fetchAsset = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockImplementation(async (request) =>
        new URL(request.url).pathname === '/offline.html'
          ? new Response('offline', { headers: { 'Set-Cookie': 'session=secret' } })
          : new Response('icon', { headers: { 'Cache-Control': 'private, no-store' } }),
      );
    const worker = createWorker(fetchAsset);
    const event = extendableEvent();

    worker.handlers.get('install')?.(event.event);
    await event.pending();

    expect(worker.cacheWrites).toEqual([]);
  });

  it('bypasses authenticated and API requests, including Set-Cookie responses', async () => {
    const worker = createWorker(
      vi.fn(async () => new Response('private', { headers: { 'Set-Cookie': 'session=secret' } })),
    );
    const authenticated = extendableEvent({
      request: new Request('https://uneventful.test/icons/icon.svg', {
        headers: { Authorization: 'Bearer test-token' },
      }),
    });
    worker.handlers.get('fetch')?.(authenticated.event);

    const apiRequest = extendableEvent({
      request: new Request('https://uneventful.test/api/v1/auth/me'),
    });
    worker.handlers.get('fetch')?.(apiRequest.event);

    expect(authenticated.response()).toBeUndefined();
    expect(apiRequest.response()).toBeUndefined();
    expect(worker.fetchAsset).not.toHaveBeenCalled();
    expect(worker.cacheWrites).toEqual([]);
  });

  it('removes old static caches on activate and all app caches on logout', async () => {
    const worker = createWorker(undefined, [
      'uneventful-static-v1',
      'uneventful-user-data-v1',
      'unrelated-cache',
    ]);
    const activate = extendableEvent();
    worker.handlers.get('activate')?.(activate.event);
    await activate.pending();

    expect(worker.deletedCaches).toEqual(['uneventful-static-v1']);
    expect(worker.self.clients.claim).toHaveBeenCalledOnce();

    const logout = extendableEvent({ data: { type: 'uneventful:logout' } });
    worker.handlers.get('message')?.(logout.event);
    await logout.pending();

    expect(worker.deletedCaches).toEqual(['uneventful-static-v1', 'uneventful-user-data-v1']);
  });
});
