'use client';

import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '@/components/auth-provider';
import { API_SOCKET_URL } from '@/lib/auth-config';

interface DashboardSnapshot {
  eventId: string;
  checkInCount: number;
  rsvpCount: number;
  attendanceRatio: number;
  capacity: number | null;
  recentCheckIns: Array<{ displayName: string; checkedInAt: string }>;
}

interface JoinResponse {
  ok: boolean;
  data?: DashboardSnapshot;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown, eventId: string): value is DashboardSnapshot {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    'attendanceRatio',
    'capacity',
    'checkInCount',
    'eventId',
    'recentCheckIns',
    'rsvpCount',
  ];
  if (
    Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',') ||
    value.eventId !== eventId ||
    !Number.isSafeInteger(value.checkInCount) ||
    !Number.isSafeInteger(value.rsvpCount) ||
    typeof value.attendanceRatio !== 'number' ||
    !Number.isFinite(value.attendanceRatio) ||
    (value.capacity !== null && !Number.isSafeInteger(value.capacity)) ||
    !Array.isArray(value.recentCheckIns)
  ) {
    return false;
  }
  return value.recentCheckIns.every(
    (entry) =>
      isRecord(entry) &&
      Object.keys(entry).sort().join(',') === 'checkedInAt,displayName' &&
      typeof entry.displayName === 'string' &&
      typeof entry.checkedInAt === 'string' &&
      Number.isFinite(Date.parse(entry.checkedInAt)),
  );
}

function parseJoinResponse(value: unknown, eventId: string): JoinResponse | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null;
  if (value.ok && isSnapshot(value.data, eventId)) {
    return { ok: true, data: value.data };
  }
  if (!value.ok && typeof value.error === 'string') {
    return { ok: false, error: value.error };
  }
  return null;
}

export function EventDashboard({ eventId }: Readonly<{ eventId: string }>) {
  const { accessToken, getValidAccessToken, userRole } = useAuth();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const canView = userRole === 'ORGANIZER' || userRole === 'ADMIN';

  useEffect(() => {
    setSnapshot(null);
    setConnected(false);
    setError('');
    if (!accessToken || !canView) {
      setLoading(false);
      if (accessToken && !canView) {
        setError('This dashboard is available to organizers and admins.');
      }
      return;
    }

    let active = true;
    setLoading(true);
    let disconnectSocket = () => {};
    const socket = io(`${API_SOCKET_URL}/realtime`, {
      auth: (callback) => {
        void getValidAccessToken()
          .then((token) => {
            if (!active) return;
            if (!token) {
              setConnected(false);
              setLoading(false);
              setError('Your session expired. Sign in again.');
              disconnectSocket();
              return;
            }
            callback({ accessToken: token });
          })
          .catch(() => {
            if (!active) return;
            setConnected(false);
            setLoading(false);
            setError('The live dashboard connection is unavailable.');
            disconnectSocket();
          });
      },
      transports: ['websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    disconnectSocket = () => socket.disconnect();

    socket.on('connect', () => {
      if (!active) return;
      setConnected(true);
      setError('');
      socket.emit('dashboard:join', { eventId }, (response: unknown) => {
        if (!active) return;
        const parsed = parseJoinResponse(response, eventId);
        if (!parsed) {
          setError('The dashboard response was invalid.');
          setLoading(false);
          return;
        }
        if (!parsed.ok) {
          setError(parsed.error ?? 'This event dashboard is unavailable.');
          setSnapshot(null);
          setLoading(false);
          return;
        }
        setSnapshot(parsed.data ?? null);
        setLoading(false);
      });
    });
    socket.on('dashboard:update', (value: unknown) => {
      if (active && isSnapshot(value, eventId)) {
        setSnapshot(value);
        setLoading(false);
      }
    });
    socket.on('dashboard:access-revoked', () => {
      if (!active) return;
      setSnapshot(null);
      setConnected(false);
      setError('Access to this event dashboard has ended.');
      socket.disconnect();
    });
    socket.on('disconnect', () => {
      if (active) setConnected(false);
    });
    socket.on('connect_error', () => {
      if (!active) return;
      setConnected(false);
      setLoading(false);
      setError('The live dashboard connection is unavailable. Reconnecting…');
    });

    return () => {
      active = false;
      socket.disconnect();
    };
  }, [accessToken, canView, eventId, getValidAccessToken]);

  if (!accessToken || !canView) {
    return (
      <section className="rounded-3xl bg-white p-8 shadow-card" role="alert">
        <h1 className="font-display text-3xl font-bold">Live event dashboard</h1>
        <p className="mt-3">{error || 'Sign in with an organizer or admin account.'}</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl">
      <p className="eyebrow">Event day</p>
      <h1 className="font-display mt-2 text-4xl font-black tracking-tight">Live event dashboard</h1>
      <p className="mt-2 text-sm text-ink/70">
        Event <span className="font-mono">{eventId}</span>
      </p>
      <p aria-live="polite" className="mt-4 text-sm font-semibold text-forest" role="status">
        {connected ? 'Live updates connected.' : 'Reconnecting to live updates…'}
      </p>

      {loading && (
        <p aria-live="polite" className="mt-8 rounded-2xl bg-white p-6 shadow-card" role="status">
          Loading event attendance…
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-2xl bg-coral/10 p-4 text-sm text-coral" role="alert">
          {error}
        </p>
      )}
      {snapshot && (
        <div aria-live="polite" aria-atomic="true" className="mt-8 space-y-8">
          <div className="grid gap-4 sm:grid-cols-3">
            <Metric label="Checked in" value={snapshot.checkInCount} />
            <Metric label="Confirmed RSVPs" value={snapshot.rsvpCount} />
            <Metric label="Attendance" value={`${Math.round(snapshot.attendanceRatio * 100)}%`} />
          </div>
          <p className="text-sm text-ink/70">
            Capacity: {snapshot.capacity === null ? 'Not set' : snapshot.capacity}
          </p>
          <section aria-labelledby="recent-checkins-heading">
            <h2 className="font-display text-2xl font-bold" id="recent-checkins-heading">
              Recent check-ins
            </h2>
            {snapshot.recentCheckIns.length === 0 ? (
              <p className="mt-3 text-sm text-ink/70">No one has checked in yet.</p>
            ) : (
              <ol className="mt-4 divide-y divide-forest/10 rounded-2xl bg-white px-5 shadow-card">
                {snapshot.recentCheckIns.map((checkIn, index) => (
                  <li
                    className="flex items-center justify-between gap-4 py-4"
                    key={`${checkIn.checkedInAt}:${index}`}
                  >
                    <span className="font-semibold">{checkIn.displayName}</span>
                    <time className="text-sm text-ink/70" dateTime={checkIn.checkedInAt}>
                      {new Date(checkIn.checkedInAt).toLocaleTimeString()}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: number | string }>) {
  return (
    <div className="rounded-2xl bg-white p-6 shadow-card">
      <p className="text-sm font-semibold text-ink/70">{label}</p>
      <p className="font-display mt-2 text-4xl font-black text-forest">{value}</p>
    </div>
  );
}
