'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import { API_BASE_URL } from '@/lib/auth-config';
import type { components } from '@/lib/api-schema';

type EventAnalyticsData = components['schemas']['EventAnalytics'];

export function EventAnalytics({ eventId }: Readonly<{ eventId: string }>) {
  const { accessToken, userRole } = useAuth();
  const [data, setData] = useState<EventAnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError('Sign in to view event analytics.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const {
        data: result,
        error: responseError,
        response,
      } = await createApiClient(accessToken).GET('/events/{id}/analytics', {
        params: { path: { id: eventId } },
        cache: 'no-store',
      });
      if (!response.ok || !result) {
        throw new Error(errorMessage(responseError, 'Analytics could not be loaded.'));
      }
      setData(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Analytics could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [accessToken, eventId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  async function downloadCsv() {
    if (!accessToken) return;
    setExporting(true);
    setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/events/${eventId}/attendees/export`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('The attendee export could not be downloaded.');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = disposition.match(/filename="([A-Za-z0-9._-]+)"/)?.[1] ?? 'attendees.csv';
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The attendee export failed.');
    } finally {
      setExporting(false);
    }
  }

  if (userRole !== 'ORGANIZER' && userRole !== 'ADMIN') {
    return <p role="alert">This page is available to event organizers and admins.</p>;
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Organizer tools</p>
          <h1 className="font-display mt-3 text-4xl font-black tracking-tight">Event analytics</h1>
          <p className="mt-2 text-sm text-ink/70">
            Small groups below five are suppressed to protect attendee privacy.
          </p>
        </div>
        <button
          className="rounded-full bg-forest px-5 py-3 font-bold text-white disabled:opacity-60"
          disabled={exporting || !accessToken}
          onClick={() => void downloadCsv()}
          type="button"
        >
          {exporting ? 'Preparing CSV…' : 'Export attendees'}
        </button>
      </header>

      {error && (
        <p className="rounded-xl bg-white p-4 text-coral" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p aria-live="polite" role="status">
          Loading analytics…
        </p>
      )}
      {!loading && data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Going', data.rsvps.going],
              ['Waitlisted', data.rsvps.waitlisted],
              ['Cancelled', data.rsvps.cancelled],
              ['Checked in', data.rsvps.checkedIn],
            ].map(([label, value]) => (
              <article className="rounded-2xl bg-white p-5 shadow-card" key={label}>
                <h2 className="text-sm font-bold text-ink/70">{label}</h2>
                <p className="font-display mt-2 text-3xl font-black">
                  {value === null ? 'Suppressed' : value}
                </p>
              </article>
            ))}
          </div>

          <section
            aria-labelledby="rsvp-trend-heading"
            className="rounded-2xl bg-white p-5 shadow-card"
          >
            <h2 className="font-display text-xl font-bold" id="rsvp-trend-heading">
              RSVP and check-in trends
            </h2>
            <p className="mt-1 text-sm text-ink/70">
              Text equivalent of the trend chart; counts smaller than five are omitted.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">RSVP and check-in totals by date</caption>
                <thead>
                  <tr className="border-b border-forest/10">
                    <th className="py-2 pr-4" scope="col">
                      Period
                    </th>
                    <th className="py-2 pr-4" scope="col">
                      Total
                    </th>
                    <th className="py-2 pr-4" scope="col">
                      Going
                    </th>
                    <th className="py-2 pr-4" scope="col">
                      Waitlisted
                    </th>
                    <th className="py-2 pr-4" scope="col">
                      Cancelled
                    </th>
                    <th className="py-2" scope="col">
                      Checked in
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rsvpsOverTime.map((row) => (
                    <tr className="border-b border-forest/5" key={row.bucket}>
                      <th className="py-2 pr-4 font-medium" scope="row">
                        {new Date(row.bucket).toLocaleDateString()}
                      </th>
                      <td className="py-2 pr-4">{row.total ?? 'Suppressed'}</td>
                      <td className="py-2 pr-4">{row.going ?? 'Suppressed'}</td>
                      <td className="py-2 pr-4">{row.waitlisted ?? 'Suppressed'}</td>
                      <td className="py-2 pr-4">{row.cancelled ?? 'Suppressed'}</td>
                      <td className="py-2">{row.checkedIn ?? 'Suppressed'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-white p-5">
              <dt className="font-bold">No-show rate</dt>
              <dd className="mt-2 text-2xl font-black">
                {data.noShowRate === null ? 'Suppressed' : `${data.noShowRate}%`}
              </dd>
            </div>
            <div className="rounded-2xl bg-white p-5">
              <dt className="font-bold">Repeat attendee rate</dt>
              <dd className="mt-2 text-2xl font-black">
                {data.repeatAttendeeRate === null ? 'Suppressed' : `${data.repeatAttendeeRate}%`}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
