'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import {
  clearEventCheckinData,
  clearQueuedScans,
  listOfflineScans,
  loadOfflineManifest,
  queueOfflineScan,
  saveOfflineManifest,
  type OfflineManifest,
  type QueuedOfflineScan,
} from '@/lib/checkin-storage';
import type { components } from '@/lib/api-schema';

type CheckinManifest = components['schemas']['CheckinManifest'];
type ScannerStatus = 'VALID' | 'ALREADY USED' | 'INVALID' | 'WRONG EVENT';
type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
};
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

interface TicketPayload {
  ticketId: string;
  eventId: string;
  rsvpId: string;
  issuedAt: number;
  expiresAt: number;
}

interface VerifiedTicket {
  claims: TicketPayload;
  ticketIdHash: string;
}

function decodeBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Ticket encoding is invalid.');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function isTicketPayload(value: unknown): value is TicketPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 5 &&
    typeof payload.ticketId === 'string' &&
    typeof payload.eventId === 'string' &&
    typeof payload.rsvpId === 'string' &&
    typeof payload.issuedAt === 'number' &&
    Number.isSafeInteger(payload.issuedAt) &&
    typeof payload.expiresAt === 'number' &&
    Number.isSafeInteger(payload.expiresAt)
  );
}

async function hashTicketId(ticketId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticketId));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyTicket(
  token: string,
  eventId: string,
  manifest: OfflineManifest,
): Promise<VerifiedTicket | ScannerStatus> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return 'INVALID';
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]!)));
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]!)));
  } catch {
    return 'INVALID';
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    return 'INVALID';
  }
  const parsedHeader = header as Record<string, unknown>;
  if (
    Object.keys(parsedHeader).length !== 3 ||
    parsedHeader.alg !== 'EdDSA' ||
    parsedHeader.typ !== 'JWT' ||
    typeof parsedHeader.kid !== 'string'
  ) {
    return 'INVALID';
  }
  if (!isTicketPayload(payload)) {
    return 'INVALID';
  }
  if (payload.eventId !== eventId) {
    return 'WRONG EVENT';
  }
  const now = Date.now();
  if (
    payload.expiresAt <= now ||
    payload.issuedAt > now + 60_000 ||
    payload.expiresAt <= payload.issuedAt
  ) {
    return 'INVALID';
  }

  const publicKey = manifest.publicKeys.keys.find((key) => key.kid === parsedHeader.kid);
  if (!publicKey) {
    return 'INVALID';
  }
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      decodeBase64Url(publicKey.publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const signatureValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      decodeBase64Url(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!signatureValid) {
      return 'INVALID';
    }
  } catch {
    return 'INVALID';
  }

  const ticketIdHash = await hashTicketId(payload.ticketId);
  const manifestTicket = manifest.data.find((entry) => entry.ticketIdHash === ticketIdHash);
  if (!manifestTicket || manifestTicket.status === 'REVOKED') {
    return 'INVALID';
  }
  if (manifestTicket.status === 'USED') {
    return 'ALREADY USED';
  }
  return { claims: payload, ticketIdHash };
}

function asOfflineManifest(value: CheckinManifest): OfflineManifest {
  return {
    eventId: value.eventId,
    eventEndAt: value.eventEndAt,
    publicKeys: value.publicKeys,
    data: value.data,
  };
}

function isOfflineManifest(value: unknown): value is OfflineManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.eventId !== 'string' ||
    typeof candidate.eventEndAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.eventEndAt)) ||
    !Array.isArray(candidate.data) ||
    typeof candidate.publicKeys !== 'object' ||
    candidate.publicKeys === null
  ) {
    return false;
  }
  const keys = (candidate.publicKeys as Record<string, unknown>).keys;
  return (
    Array.isArray(keys) &&
    keys.every(
      (key) =>
        typeof key === 'object' &&
        key !== null &&
        typeof (key as Record<string, unknown>).kid === 'string' &&
        typeof (key as Record<string, unknown>).publicKey === 'string',
    ) &&
    candidate.data.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).ticketIdHash === 'string' &&
        /^[a-f0-9]{64}$/i.test((entry as Record<string, unknown>).ticketIdHash as string) &&
        ['ISSUED', 'USED', 'REVOKED'].includes((entry as Record<string, unknown>).status as string),
    )
  );
}

export function CheckinScanner({ eventId }: Readonly<{ eventId: string }>) {
  const { accessToken } = useAuth();
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastScannedRef = useRef('');
  const processingRef = useRef(false);
  const [manifest, setManifest] = useState<OfflineManifest | null>(null);
  const [queue, setQueue] = useState<QueuedOfflineScan[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [isOnline, setIsOnline] = useState(true);

  const refreshQueue = useCallback(async () => {
    setQueue(await listOfflineScans(eventId));
  }, [eventId]);

  const fetchManifest = useCallback(async (): Promise<OfflineManifest> => {
    if (!accessToken) {
      throw new Error('Sign in again before loading the check-in manifest.');
    }
    const client = createApiClient(accessToken);
    const allTickets: OfflineManifest['data'] = [];
    let firstPage: CheckinManifest | undefined;
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const {
        data,
        error: responseError,
        response,
      } = await client.GET('/events/{id}/checkin-manifest', {
        params: {
          path: { id: eventId },
          query: cursor ? { cursor } : {},
        },
      });
      if (!response.ok || !data) {
        throw new Error(errorMessage(responseError, 'The check-in manifest could not be loaded.'));
      }
      firstPage ??= data;
      allTickets.push(...data.data);
      cursor = data.nextCursor;
      if (!cursor) {
        const complete = asOfflineManifest({ ...firstPage, data: allTickets });
        await saveOfflineManifest(complete);
        return complete;
      }
    }
    throw new Error('The event manifest is too large to download to this device.');
  }, [accessToken, eventId]);

  const refreshManifest = useCallback(async () => {
    try {
      setManifest(await fetchManifest());
      setError('');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'The check-in manifest could not be refreshed.',
      );
    }
  }, [fetchManifest]);

  useEffect(() => {
    let active = true;
    setIsOnline(navigator.onLine);
    void (async () => {
      try {
        const cachedData = await loadOfflineManifest(eventId);
        const cached =
          isOfflineManifest(cachedData) && cachedData.eventId === eventId ? cachedData : undefined;
        if (cachedData && !cached) {
          await clearEventCheckinData(eventId);
        } else if (cached && new Date(cached.eventEndAt).getTime() <= Date.now()) {
          await clearEventCheckinData(eventId);
        } else if (cached && active) {
          setManifest(cached);
        }

        if (navigator.onLine) {
          const current = await fetchManifest();
          if (active) setManifest(current);
        } else if (!cached && active) {
          setError('No saved event manifest is available for offline check-in.');
        }
        await refreshQueue();
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : 'Check-in data could not be loaded.');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [eventId, fetchManifest, refreshQueue]);

  useEffect(() => {
    if (!manifest) return;
    const remaining = new Date(manifest.eventEndAt).getTime() - Date.now();
    if (remaining <= 0) {
      void clearEventCheckinData(eventId).then(() => {
        setManifest(null);
        setQueue([]);
        setError('This event has ended. Its offline manifest and scan queue were cleared.');
      });
      return;
    }
    const timer = window.setInterval(() => {
      if (Date.now() < new Date(manifest.eventEndAt).getTime()) return;
      window.clearInterval(timer);
      void clearEventCheckinData(eventId).then(() => {
        setManifest(null);
        setQueue([]);
        setError('This event has ended. Its offline manifest and scan queue were cleared.');
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [eventId, manifest]);

  useEffect(() => {
    const updateOnline = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  const handleTicket = useCallback(
    async (token: string) => {
      if (!manifest || !accessToken || processingRef.current || token === lastScannedRef.current) {
        return;
      }
      processingRef.current = true;
      lastScannedRef.current = token;
      setError('');
      try {
        const verified = await verifyTicket(token, eventId, manifest);
        if (typeof verified === 'string') {
          setStatus(verified);
          return;
        }
        if (navigator.onLine) {
          try {
            const {
              data,
              error: responseError,
              response,
            } = await createApiClient(accessToken).POST('/events/{id}/checkins', {
              params: { path: { id: eventId } },
              body: { ticket: token, deviceId: crypto.randomUUID() },
            });
            if (!response.ok || !data) {
              setStatus(response.status === 404 ? 'INVALID' : '');
              setError(errorMessage(responseError, 'The ticket could not be checked in.'));
              return;
            }
            setStatus(data.status === 'VALID' ? 'VALID' : 'ALREADY USED');
          } catch {
            await queueOfflineScan({
              eventId,
              ticketIdHash: verified.ticketIdHash,
              deviceId: crypto.randomUUID(),
              scannedAt: new Date().toISOString(),
            });
            await refreshQueue();
            setStatus('VALID');
            setError('Offline scan queued; it will be verified when the device reconnects.');
          }
        } else {
          await queueOfflineScan({
            eventId,
            ticketIdHash: verified.ticketIdHash,
            deviceId: crypto.randomUUID(),
            scannedAt: new Date().toISOString(),
          });
          await refreshQueue();
          setStatus('VALID');
          setError('Offline scan queued; it will be verified when the device reconnects.');
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Ticket could not be checked.');
      } finally {
        processingRef.current = false;
      }
    },
    [accessToken, eventId, manifest, refreshQueue],
  );

  useEffect(() => {
    let active = true;
    let stream: MediaStream | undefined;
    let interval = 0;
    let detector: BarcodeDetectorLike | undefined;

    void (async () => {
      const BarcodeDetectorApi = (
        window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }
      ).BarcodeDetector;
      if (!BarcodeDetectorApi) {
        setCameraError('QR scanning is not supported by this browser.');
        return;
      }
      try {
        detector = new BarcodeDetectorApi({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!active || !videoRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        interval = window.setInterval(() => {
          const video = videoRef.current;
          if (
            !video ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            processingRef.current
          ) {
            return;
          }
          void detector
            ?.detect(video)
            .then((codes) => {
              const token = codes[0]?.rawValue;
              if (token) void handleTicket(token);
            })
            .catch(() => setCameraError('The QR code could not be read.'));
        }, 500);
      } catch {
        setCameraError('Camera access is unavailable. Allow camera access and reload this page.');
      }
    })();

    return () => {
      active = false;
      window.clearInterval(interval);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [handleTicket]);

  const syncQueue = useCallback(async () => {
    if (!accessToken || !navigator.onLine || queue.length === 0) return;
    setError('');
    try {
      const {
        data,
        error: responseError,
        response,
      } = await createApiClient(accessToken).POST('/events/{id}/checkins/sync', {
        params: { path: { id: eventId } },
        body: {
          scans: queue.map(({ ticketIdHash, deviceId, scannedAt }) => ({
            ticketIdHash,
            deviceId,
            scannedAt,
          })),
        },
      });
      if (!response.ok || !data) {
        throw new Error(errorMessage(responseError, 'Offline scans could not be synchronized.'));
      }
      await clearQueuedScans(eventId);
      await refreshQueue();
      const latest = data.data.at(-1);
      if (latest) {
        setStatus(
          latest.status === 'VALID'
            ? 'VALID'
            : latest.status === 'DUPLICATE'
              ? 'ALREADY USED'
              : latest.status === 'WRONG_EVENT'
                ? 'WRONG EVENT'
                : latest.status,
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Offline scans could not be synchronized.',
      );
    }
  }, [accessToken, eventId, queue, refreshQueue]);

  useEffect(() => {
    if (isOnline && queue.length > 0) void syncQueue();
  }, [isOnline, queue.length, syncQueue]);

  return (
    <section className="mx-auto max-w-3xl">
      <p className="eyebrow">Organizer tools</p>
      <h1 className="font-display mt-3 text-4xl font-black tracking-tight">Event check-in</h1>
      <p className="mt-3 text-sm leading-6 text-ink/70">
        Scan a signed ticket. Offline scans are stored as ticket ID hashes and timestamps only, then
        synchronized when the device reconnects. Access tokens and ticket tokens are never stored in
        IndexedDB or browser storage.
      </p>
      <div className="mt-6 rounded-3xl border border-forest/10 bg-white p-5 shadow-card">
        <video
          aria-label="Camera view for scanning event tickets"
          className="aspect-video w-full rounded-2xl bg-ink"
          muted
          playsInline
          ref={videoRef}
        />
        {cameraError && (
          <p className="mt-3 text-sm text-coral" role="alert">
            {cameraError}
          </p>
        )}
        {!manifest && !error && (
          <p aria-live="polite" className="mt-3 text-sm text-ink/70" role="status">
            Loading event manifest…
          </p>
        )}
        {status && (
          <p
            aria-live="assertive"
            className={`mt-4 rounded-xl p-4 text-center text-lg font-black ${
              status === 'VALID'
                ? 'bg-mint/60 text-forest'
                : status === 'ALREADY USED'
                  ? 'bg-amber-100 text-amber-900'
                  : 'bg-coral/10 text-coral'
            }`}
            role="status"
          >
            {status}
          </p>
        )}
        {error && (
          <p className="mt-3 text-sm text-coral" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink/70">
            {queue.length} offline scan{queue.length === 1 ? '' : 's'} queued ·{' '}
            {isOnline ? 'Online' : 'Offline'}
          </p>
          <div className="flex gap-3">
            <button
              className="rounded-full border border-forest/20 px-4 py-2 text-sm font-bold text-forest"
              onClick={() => {
                lastScannedRef.current = '';
                setStatus('');
              }}
              type="button"
            >
              Scan another
            </button>
            <button
              className="rounded-full border border-forest/20 px-4 py-2 text-sm font-bold text-forest disabled:opacity-50"
              disabled={!isOnline}
              onClick={() => void refreshManifest()}
              type="button"
            >
              Refresh manifest
            </button>
            <button
              className="rounded-full bg-forest px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              disabled={!isOnline || queue.length === 0}
              onClick={() => void syncQueue()}
              type="button"
            >
              Sync queue
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
