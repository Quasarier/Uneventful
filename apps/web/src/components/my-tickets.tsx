'use client';

import { useState } from 'react';
import Image from 'next/image';
import QRCode from 'qrcode';
import { useAuth } from '@/components/auth-provider';
import { useMyRsvps } from '@/components/use-my-rsvps';
import { createApiClient, errorMessage } from '@/lib/api-client';
import { eventIsPast, formatEventDate } from '@/lib/event-format';

interface TicketView {
  token: string;
  image: string;
}

export function MyTickets() {
  const { accessToken } = useAuth();
  const { rsvps, loading, error, reload } = useMyRsvps();
  const [tickets, setTickets] = useState<Record<string, TicketView>>({});
  const [loadingId, setLoadingId] = useState('');
  const [ticketError, setTicketError] = useState('');
  const [status, setStatus] = useState('');
  const currentRsvps = rsvps.filter((rsvp) => rsvp.status === 'GOING' && !eventIsPast(rsvp.event));

  async function showTicket(eventId: string, rsvpId: string) {
    if (!accessToken) return;
    setLoadingId(rsvpId);
    setTicketError('');
    setStatus('');
    try {
      const {
        data,
        error: responseError,
        response,
      } = await createApiClient(accessToken).POST('/events/{id}/rsvp/ticket', {
        params: { path: { id: eventId } },
      });
      if (!response.ok || !data) {
        throw new Error(errorMessage(responseError, 'Ticket could not be issued.'));
      }
      const image = await QRCode.toDataURL(data.token, {
        errorCorrectionLevel: 'Q',
        margin: 2,
        width: 240,
      });
      setTickets((current) => ({ ...current, [rsvpId]: { token: data.token, image } }));
      setStatus(
        'Signed ticket QR code is ready. Keep it private; it expires two hours after the event ends.',
      );
    } catch (reason) {
      setTicketError(reason instanceof Error ? reason.message : 'Ticket could not be issued.');
    } finally {
      setLoadingId('');
    }
  }

  return (
    <section>
      <div className="mb-8 max-w-3xl">
        <p className="eyebrow">Your entry passes</p>
        <h1 className="font-display mt-3 text-4xl font-black tracking-tight sm:text-5xl">
          My tickets
        </h1>
        <p className="mt-4 text-base leading-7 text-ink/70">
          Open a ticket QR code when you’re ready to check in. Codes stay in this page session only.
        </p>
      </div>
      {loading && (
        <p aria-live="polite" className="py-8 font-semibold text-forest" role="status">
          Loading your tickets…
        </p>
      )}
      {error && (
        <p className="mb-5 rounded-2xl bg-white p-4 text-coral" role="alert">
          {error}
        </p>
      )}
      {ticketError && (
        <p className="mb-5 rounded-2xl bg-white p-4 text-coral" role="alert">
          {ticketError}
        </p>
      )}
      <p aria-live="polite" className="sr-only" role="status">
        {status}
      </p>
      {!loading && currentRsvps.length === 0 && !error && (
        <div className="rounded-3xl border border-dashed border-forest/25 bg-white p-8 text-center">
          <h2 className="font-display text-2xl font-bold">No upcoming tickets yet</h2>
          <p className="mt-2 text-ink/70">
            When an event confirms your RSVP, your ticket will appear here.
          </p>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        {currentRsvps.map((rsvp) => {
          const ticket = tickets[rsvp.id];
          return (
            <article
              className="grid gap-5 rounded-3xl border border-forest/10 bg-white p-5 shadow-card sm:grid-cols-[1fr_auto] sm:p-6"
              key={rsvp.id}
            >
              <div>
                <p className="eyebrow">{rsvp.event.club.name}</p>
                <h2 className="font-display mt-2 text-2xl font-bold">{rsvp.event.title}</h2>
                <p className="mt-3 text-sm text-ink/70">
                  <time dateTime={rsvp.event.startAt}>
                    {formatEventDate(rsvp.event.startAt, rsvp.event.timeZone)}
                  </time>
                </p>
                <p className="mt-3 inline-flex rounded-full bg-mint/60 px-3 py-1 text-xs font-bold text-forest">
                  {rsvp.ticket?.status === 'USED' ? 'Checked in' : 'RSVP confirmed'}
                </p>
                <div className="mt-5">
                  <button
                    className="rounded-full bg-forest px-5 py-2.5 text-sm font-bold text-white hover:bg-forest/90 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={loadingId === rsvp.id || rsvp.ticket?.status === 'USED'}
                    onClick={() => void showTicket(rsvp.event.id, rsvp.id)}
                    type="button"
                  >
                    {loadingId === rsvp.id
                      ? 'Preparing ticket…'
                      : ticket
                        ? 'Refresh QR code'
                        : 'Show ticket QR'}
                  </button>
                </div>
              </div>
              {ticket && (
                <div className="self-center rounded-2xl border border-forest/10 bg-white p-3 text-center">
                  {/* The one-time ticket token is held in component memory only. */}
                  <Image
                    alt={`Entry ticket QR code for ${rsvp.event.title}`}
                    className="mx-auto size-48"
                    height={192}
                    src={ticket.image}
                    unoptimized
                    width={192}
                  />
                  <details className="mt-2 max-w-48 text-left">
                    <summary className="cursor-pointer text-xs font-bold text-forest underline">
                      Accessible ticket code
                    </summary>
                    <code className="mt-2 block break-all text-xs text-ink/75">{ticket.token}</code>
                  </details>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!loading && !error && (
        <button
          className="mt-6 text-sm font-bold text-forest underline underline-offset-4"
          onClick={() => void reload()}
          type="button"
        >
          Refresh tickets
        </button>
      )}
    </section>
  );
}
