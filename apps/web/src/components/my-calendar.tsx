'use client';

import { useState } from 'react';
import { useMyRsvps } from '@/components/use-my-rsvps';
import { formatEventDate } from '@/lib/event-format';
import { createIcal } from '@/lib/calendar';

export function MyCalendar() {
  const { rsvps, loading, error, reload } = useMyRsvps();
  const [downloadError, setDownloadError] = useState('');
  const sortedRsvps = [...rsvps].sort(
    (first, second) =>
      new Date(first.event.startAt).getTime() - new Date(second.event.startAt).getTime(),
  );

  function exportCalendar() {
    setDownloadError('');
    try {
      const contents = createIcal(sortedRsvps);
      const file = new Blob([contents], { type: 'text/calendar;charset=utf-8' });
      const fileUrl = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = fileUrl;
      link.download = 'campuspulse-calendar.ics';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(fileUrl), 0);
    } catch {
      setDownloadError('Calendar export could not be created. Please try again.');
    }
  }

  return (
    <section>
      <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <p className="eyebrow">Plans you’ve made</p>
          <h1 className="font-display mt-3 text-4xl font-black tracking-tight sm:text-5xl">
            My calendar
          </h1>
          <p className="mt-4 text-base leading-7 text-ink/70">
            All your confirmed and waitlisted event plans, in date order.
          </p>
        </div>
        <button
          className="w-fit rounded-full bg-forest px-5 py-3 text-sm font-bold text-white hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading || sortedRsvps.length === 0}
          onClick={exportCalendar}
          type="button"
        >
          Export iCal
        </button>
      </div>
      {loading && (
        <p aria-live="polite" className="py-8 font-semibold text-forest" role="status">
          Loading your calendar…
        </p>
      )}
      {error && (
        <p className="mb-5 rounded-2xl bg-white p-4 text-coral" role="alert">
          {error}
        </p>
      )}
      {downloadError && (
        <p className="mb-5 rounded-2xl bg-white p-4 text-coral" role="alert">
          {downloadError}
        </p>
      )}
      {!loading && sortedRsvps.length === 0 && !error && (
        <div className="rounded-3xl border border-dashed border-forest/25 bg-white p-8 text-center">
          <h2 className="font-display text-2xl font-bold">Your calendar is waiting</h2>
          <p className="mt-2 text-ink/70">RSVP to an event to see it here.</p>
        </div>
      )}
      <ol className="space-y-4">
        {sortedRsvps.map((rsvp) => (
          <li
            className="flex flex-col gap-4 rounded-3xl border border-forest/10 bg-white p-5 shadow-card sm:flex-row sm:items-center"
            key={rsvp.id}
          >
            <div
              aria-hidden="true"
              className="grid size-14 shrink-0 place-items-center rounded-2xl bg-mint/60 text-lg font-black text-forest"
            >
              {new Intl.DateTimeFormat(undefined, {
                month: 'short',
                day: 'numeric',
                timeZone: rsvp.event.timeZone,
              }).format(new Date(rsvp.event.startAt))}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-forest">{rsvp.event.club.name}</p>
              <h2 className="font-display mt-1 text-xl font-bold">{rsvp.event.title}</h2>
              <p className="mt-1 text-sm text-ink/70">
                <time dateTime={rsvp.event.startAt}>
                  {formatEventDate(rsvp.event.startAt, rsvp.event.timeZone)}
                </time>
              </p>
            </div>
            <span
              className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${rsvp.status === 'WAITLISTED' ? 'bg-amber-100 text-amber-950' : 'bg-mint/60 text-forest'}`}
            >
              {rsvp.status === 'WAITLISTED'
                ? `Waitlist${rsvp.waitlistPosition ? ` #${rsvp.waitlistPosition}` : ''}`
                : 'Going'}
            </span>
          </li>
        ))}
      </ol>
      {!loading && !error && sortedRsvps.length > 0 && (
        <button
          className="mt-6 text-sm font-bold text-forest underline underline-offset-4"
          onClick={() => void reload()}
          type="button"
        >
          Refresh calendar
        </button>
      )}
    </section>
  );
}
