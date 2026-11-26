'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { EventImage } from '@/components/event-image';
import { createApiClient, errorMessage } from '@/lib/api-client';
import { formatEventDate, type EventItem } from '@/lib/event-format';

type EventRsvpStatus = {
  status: 'GOING' | 'WAITLISTED' | 'CANCELLED' | 'CHECKED_IN' | null;
  waitlistPosition: number | null;
  capacity: number | null;
  goingCount: number;
  isFull: boolean;
};

export function EventDetail({ eventId }: Readonly<{ eventId: string }>) {
  const { accessToken, userRole } = useAuth();
  const [event, setEvent] = useState<EventItem | null>(null);
  const [rsvp, setRsvp] = useState<EventRsvpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkConflicts, setCheckConflicts] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [followingClub, setFollowingClub] = useState(false);
  const [followError, setFollowError] = useState('');

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError('');
    setStatusError('');
    try {
      const client = createApiClient(accessToken);
      const [eventResult, statusResult] = await Promise.all([
        client.GET('/events/{id}', { params: { path: { id: eventId } } }),
        client.GET('/events/{id}/rsvp/status', { params: { path: { id: eventId } } }),
      ]);
      if (!eventResult.response.ok || !eventResult.data) {
        throw new Error(errorMessage(eventResult.error, 'Event details could not be loaded.'));
      }
      setEvent(eventResult.data);
      if (statusResult.response.ok && statusResult.data) {
        setRsvp(statusResult.data);
      } else {
        setRsvp(null);
        setStatusError(errorMessage(statusResult.error, 'Availability could not be checked.'));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Event details could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [accessToken, eventId]);

  useEffect(() => {
    setFollowingClub(false);
    setFollowError('');
    void load();
  }, [eventId, load]);

  async function submitRsvp() {
    if (!accessToken || !rsvp) return;
    const previous = rsvp;
    const wasFull = rsvp.isFull;
    setRsvp({
      ...rsvp,
      status: wasFull ? 'WAITLISTED' : 'GOING',
      waitlistPosition: wasFull ? (rsvp.waitlistPosition ?? 0) + 1 : null,
      goingCount: wasFull ? rsvp.goingCount : rsvp.goingCount + 1,
      isFull:
        rsvp.capacity !== null &&
        (wasFull ? rsvp.goingCount >= rsvp.capacity : rsvp.goingCount + 1 >= rsvp.capacity),
    });
    setSaving(true);
    setError('');
    try {
      const {
        data,
        error: responseError,
        response,
      } = await createApiClient(accessToken).POST('/events/{id}/rsvp', {
        params: { path: { id: eventId } },
        body: { checkConflicts },
      });
      if (!response.ok || !data) {
        throw new Error(errorMessage(responseError, 'Your RSVP could not be saved.'));
      }
      await load();
    } catch (reason) {
      setRsvp(previous);
      setError(reason instanceof Error ? reason.message : 'Your RSVP could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function cancelRsvp() {
    if (!accessToken || !rsvp) return;
    const previous = rsvp;
    setRsvp({
      ...rsvp,
      status: null,
      waitlistPosition: null,
      goingCount: rsvp.status === 'GOING' ? Math.max(0, rsvp.goingCount - 1) : rsvp.goingCount,
      isFull:
        rsvp.capacity !== null &&
        (rsvp.status === 'GOING' ? rsvp.goingCount - 1 >= rsvp.capacity : rsvp.isFull),
    });
    setSaving(true);
    setError('');
    try {
      const { error: responseError, response } = await createApiClient(accessToken).DELETE(
        '/events/{id}/rsvp',
        { params: { path: { id: eventId } } },
      );
      if (!response.ok) {
        throw new Error(errorMessage(responseError, 'Your RSVP could not be cancelled.'));
      }
      await load();
    } catch (reason) {
      setRsvp(previous);
      setError(reason instanceof Error ? reason.message : 'Your RSVP could not be cancelled.');
    } finally {
      setSaving(false);
    }
  }

  async function followClub(clubId: string) {
    if (!accessToken) return;
    setFollowError('');
    try {
      const { error: responseError, response } = await createApiClient(accessToken).POST(
        '/clubs/{id}/follow',
        { params: { path: { id: clubId } } },
      );
      if (!response.ok) {
        throw new Error(errorMessage(responseError, 'The club could not be followed.'));
      }
      setFollowingClub(true);
    } catch (reason) {
      setFollowError(reason instanceof Error ? reason.message : 'The club could not be followed.');
    }
  }

  if (loading) {
    return (
      <p aria-live="polite" className="py-12 font-semibold text-forest" role="status">
        Loading event…
      </p>
    );
  }
  if (error && !event) {
    return (
      <section className="rounded-3xl bg-white p-8 shadow-card" role="alert">
        <h1 className="font-display text-3xl font-bold">Event unavailable</h1>
        <p className="mt-3">{error}</p>
        <button
          className="mt-5 rounded-full bg-forest px-5 py-2.5 font-bold text-white"
          onClick={() => void load()}
          type="button"
        >
          Try again
        </button>
        <Link className="ml-4 font-bold text-forest underline" href="/events">
          Back to events
        </Link>
      </section>
    );
  }
  if (!event) return null;

  const isPast = new Date(event.startAt).getTime() <= Date.now();
  const isGoing = rsvp?.status === 'GOING' || rsvp?.status === 'CHECKED_IN';
  const isWaitlisted = rsvp?.status === 'WAITLISTED';
  const canRsvp = Boolean(
    userRole === 'STUDENT' && rsvp && !isPast && rsvp.status !== 'CHECKED_IN',
  );

  return (
    <article className="mx-auto max-w-4xl">
      <Link className="text-sm font-bold text-forest underline underline-offset-4" href="/events">
        ← All events
      </Link>
      {(userRole === 'ORGANIZER' || userRole === 'ADMIN') && (
        <Link
          className="ml-5 text-sm font-bold text-forest underline underline-offset-4"
          href={`/events/${eventId}/scanner`}
        >
          Open check-in scanner
        </Link>
      )}
      {(userRole === 'ORGANIZER' || userRole === 'ADMIN') && (
        <Link
          className="ml-5 text-sm font-bold text-forest underline underline-offset-4"
          href={`/events/${eventId}/dashboard`}
        >
          Open live dashboard
        </Link>
      )}
      {(userRole === 'ORGANIZER' || userRole === 'ADMIN') && (
        <Link
          className="ml-5 text-sm font-bold text-forest underline underline-offset-4"
          href={`/events/${eventId}/analytics`}
        >
          View event analytics
        </Link>
      )}
      <header className="mt-6 rounded-[2rem] bg-forest p-7 text-white sm:p-10">
        <p className="text-sm font-bold text-mint">
          {event.category.name} · {event.club.name}
        </p>
        {userRole === 'STUDENT' && (
          <div className="mt-3">
            <button
              className="rounded-full border border-white/40 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
              disabled={followingClub}
              onClick={() => void followClub(event.clubId)}
              type="button"
            >
              {followingClub ? 'Following this club' : 'Follow this club'}
            </button>
            {followError && (
              <p className="mt-2 text-sm text-white" role="alert">
                {followError}
              </p>
            )}
          </div>
        )}
        <h1 className="font-display mt-4 text-4xl font-black tracking-tight sm:text-6xl">
          {event.title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-white/85">
          {formatEventDate(event.startAt, event.timeZone)} –{' '}
          {formatEventDate(event.endAt, event.timeZone)}
        </p>
        {event.venue && (
          <p className="mt-3 text-sm text-white/80">
            Location: {event.venue.name}
            {event.venue.building ? ` · ${event.venue.building}` : ''}
          </p>
        )}
        {event.capacity !== null && (
          <p className="mt-3 text-sm text-white/80">
            {rsvp
              ? `${rsvp.goingCount} of ${event.capacity} spots taken`
              : `${event.capacity} spots`}
          </p>
        )}
        {event.hasImage && (
          <EventImage
            accessToken={accessToken}
            alt={`Event image for ${event.title}`}
            eventId={eventId}
          />
        )}
      </header>

      <div className="mt-7 grid gap-6 lg:grid-cols-[1fr_19rem]">
        <section className="rounded-3xl border border-forest/10 bg-white p-6 shadow-card sm:p-8">
          <h2 className="font-display text-2xl font-bold">About this event</h2>
          <p className="mt-4 whitespace-pre-wrap text-base leading-7 text-ink/80">
            {event.description}
          </p>
        </section>
        <aside className="h-fit rounded-3xl border border-forest/10 bg-white p-6 shadow-card">
          <p className="eyebrow">Your RSVP</p>
          <div
            aria-live="polite"
            className="mt-3 rounded-2xl bg-paper p-4 text-sm font-semibold text-forest"
            role="status"
          >
            {isGoing && (rsvp?.status === 'CHECKED_IN' ? 'You’ve checked in.' : 'You’re going.')}
            {isWaitlisted &&
              `You’re on the waitlist${rsvp.waitlistPosition ? ` at position ${rsvp.waitlistPosition}` : ''}.`}
            {!isGoing && !isWaitlisted && rsvp?.isFull && 'This event is full. Join the waitlist.'}
            {!isGoing && !isWaitlisted && rsvp && !rsvp.isFull && !isPast && 'Spots are available.'}
            {isPast && 'RSVPs are closed for this event.'}
            {userRole !== 'STUDENT' && 'RSVPs are available to student accounts.'}
            {!rsvp && !isPast && 'Availability is currently unknown.'}
          </div>
          {statusError && (
            <p className="mt-3 text-sm text-coral" role="alert">
              {statusError}
            </p>
          )}
          {canRsvp && (
            <>
              {isGoing || isWaitlisted ? (
                <button
                  className="mt-5 w-full rounded-full border border-forest/25 px-5 py-3 font-bold text-forest hover:bg-paper disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={saving}
                  onClick={() => void cancelRsvp()}
                  type="button"
                >
                  {saving ? 'Updating…' : 'Cancel RSVP'}
                </button>
              ) : (
                <>
                  <label className="mt-5 flex items-start gap-3 text-sm leading-5 text-ink/75">
                    <input
                      checked={checkConflicts}
                      className="mt-1 size-4 accent-forest"
                      onChange={(change) => setCheckConflicts(change.target.checked)}
                      type="checkbox"
                    />
                    Check for and block overlapping events
                  </label>
                  <button
                    className="mt-4 w-full rounded-full bg-forest px-5 py-3 font-bold text-white hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={saving || !rsvp || Boolean(statusError)}
                    onClick={() => void submitRsvp()}
                    type="button"
                  >
                    {saving ? 'Saving…' : rsvp?.isFull ? 'Join waitlist' : 'RSVP'}
                  </button>
                </>
              )}
            </>
          )}
          {error && (
            <p className="mt-4 text-sm text-coral" role="alert">
              {error}
            </p>
          )}
          <p className="mt-4 text-xs leading-5 text-ink/70">
            Your ticket will be available in My tickets after your RSVP is confirmed.
          </p>
        </aside>
      </div>
    </article>
  );
}
