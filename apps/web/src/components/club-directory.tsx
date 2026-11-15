'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import type { EventItem } from '@/lib/event-format';

export function ClubDirectory() {
  const { accessToken } = useAuth();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const loadPage = useCallback(
    async (targetPage: number) => {
      if (!accessToken) return;
      setLoading(true);
      setError('');
      try {
        const {
          data,
          error: responseError,
          response,
        } = await createApiClient(accessToken).GET('/events', {
          params: { query: { page: targetPage, limit: 100 } },
        });
        if (!response.ok || !data) {
          throw new Error(errorMessage(responseError, 'Clubs could not be loaded.'));
        }
        setEvents((current) => (targetPage === 1 ? data.data : [...current, ...data.data]));
        setPage(data.page);
        setTotalPages(data.totalPages);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Clubs could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [accessToken],
  );

  useEffect(() => {
    void loadPage(1);
  }, [loadPage]);

  const clubs = useMemo(() => {
    const unique = new Map<string, { id: string; name: string; slug: string; count: number }>();
    for (const event of events) {
      const club = unique.get(event.clubId);
      if (club) {
        club.count += 1;
      } else {
        unique.set(event.clubId, {
          id: event.clubId,
          name: event.club.name,
          slug: event.club.slug,
          count: 1,
        });
      }
    }
    return [...unique.values()]
      .filter((club) => club.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [events, query]);

  return (
    <section>
      <div className="mb-8 max-w-3xl">
        <p className="eyebrow">Campus community</p>
        <h1 className="font-display mt-3 text-4xl font-black tracking-tight sm:text-5xl">
          Meet the clubs
        </h1>
        <p className="mt-4 text-base leading-7 text-ink/70">
          Explore clubs hosting public events and find a community that feels like yours.
        </p>
      </div>
      <label className="mb-6 block max-w-lg">
        <span className="mb-1.5 block text-sm font-bold">Find a club</span>
        <input
          className="field"
          onChange={(change) => setQuery(change.target.value)}
          placeholder="Search clubs"
          type="search"
          value={query}
        />
      </label>
      {error && (
        <p className="mb-6 rounded-2xl bg-white p-4 text-coral" role="alert">
          {error}
        </p>
      )}
      <div aria-live="polite" className="sr-only" role="status">
        {loading ? 'Loading clubs.' : `${clubs.length} clubs found.`}
      </div>
      {clubs.length === 0 && !loading && !error ? (
        <div className="rounded-3xl border border-dashed border-forest/25 bg-white p-8 text-center">
          <h2 className="font-display text-2xl font-bold">No clubs found</h2>
          <p className="mt-2 text-ink/70">
            Try another search or check back when more events are posted.
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {clubs.map((club) => (
            <article
              className="rounded-3xl border border-forest/10 bg-white p-6 shadow-card"
              key={club.id}
            >
              <p className="eyebrow">
                {club.count} {club.count === 1 ? 'event found' : 'events found'} so far
              </p>
              <h2 className="font-display mt-3 text-2xl font-bold">{club.name}</h2>
              <Link
                className="mt-5 inline-flex rounded-full border border-forest/25 px-4 py-2 text-sm font-bold text-forest hover:bg-mint/50"
                href={`/clubs/${encodeURIComponent(club.id)}/${encodeURIComponent(club.slug)}`}
              >
                View club events
                <span className="sr-only"> for {club.name}</span>
              </Link>
            </article>
          ))}
        </div>
      )}
      {loading && (
        <p aria-live="polite" className="py-8 text-center font-semibold text-forest" role="status">
          Loading clubs…
        </p>
      )}
      {!loading && page < totalPages && (
        <div className="py-8 text-center">
          <button
            className="rounded-full border border-forest/30 bg-white px-6 py-3 font-bold text-forest hover:bg-mint/50"
            onClick={() => void loadPage(page + 1)}
            type="button"
          >
            Load more clubs
          </button>
        </div>
      )}
    </section>
  );
}
