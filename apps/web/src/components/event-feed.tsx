'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EventCard } from '@/components/event-card';
import { RecommendedEvents } from '@/components/recommendations';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import type { EventItem } from '@/lib/event-format';

interface EventFilters {
  search: string;
  startDate: string;
  endDate: string;
  categoryId: string;
  clubId: string;
}

const emptyFilters: EventFilters = {
  search: '',
  startDate: '',
  endDate: '',
  categoryId: '',
  clubId: '',
};

export function EventFeed({
  initialClubId,
  heading = 'Find your next campus moment',
  description = 'Discover what’s happening across campus and save a spot.',
}: Readonly<{
  initialClubId?: string;
  heading?: string;
  description?: string;
}>) {
  const { accessToken } = useAuth();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [filters, setFilters] = useState(emptyFilters);
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [categoryOptions, setCategoryOptions] = useState<Map<string, string>>(new Map());
  const [clubOptions, setClubOptions] = useState<Map<string, string>>(new Map());
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);

  const loadEvents = useCallback(
    async (targetPage: number, append: boolean) => {
      if (!accessToken || (append && inFlightRef.current)) {
        return;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestId = ++requestIdRef.current;
      inFlightRef.current = true;
      setLoading(true);
      setError('');

      const query: {
        page: number;
        limit: number;
        categoryId?: string;
        clubId?: string;
        startDate?: string;
        endDate?: string;
        q?: string;
      } = {
        page: targetPage,
        limit: 20,
      };
      if (filters.categoryId) query.categoryId = filters.categoryId;
      if (filters.clubId || initialClubId) query.clubId = filters.clubId || initialClubId;
      if (filters.startDate) query.startDate = filters.startDate;
      if (filters.endDate) query.endDate = filters.endDate;
      if (filters.search.trim()) query.q = filters.search.trim();

      try {
        const {
          data,
          error: responseError,
          response,
        } = await createApiClient(accessToken).GET('/events', {
          params: { query },
          signal: controller.signal,
        });
        if (requestId !== requestIdRef.current) return;
        if (!response.ok || !data) {
          throw new Error(errorMessage(responseError, 'Events could not be loaded.'));
        }
        setEvents((current) => (append ? [...current, ...data.data] : data.data));
        setPage(data.page);
        setTotalPages(data.totalPages);
        setCategoryOptions((current) => {
          const next = new Map(current);
          for (const event of data.data) next.set(event.categoryId, event.category.name);
          return next;
        });
        setClubOptions((current) => {
          const next = new Map(current);
          for (const event of data.data) next.set(event.clubId, event.club.name);
          return next;
        });
      } catch (reason) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setError(reason instanceof Error ? reason.message : 'Events could not be loaded.');
        if (!append) setEvents([]);
      } finally {
        if (requestId === requestIdRef.current) {
          inFlightRef.current = false;
          setLoading(false);
        }
      }
    },
    [accessToken, filters, initialClubId],
  );

  useEffect(() => {
    void loadEvents(1, false);
    return () => {
      requestIdRef.current += 1;
      controllerRef.current?.abort();
      inFlightRef.current = false;
    };
  }, [loadEvents]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loading || page >= totalPages) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadEvents(page + 1, true);
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadEvents, loading, page, totalPages]);

  const categories = useMemo(
    () => [...categoryOptions.entries()].sort((first, second) => first[1].localeCompare(second[1])),
    [categoryOptions],
  );
  const clubs = useMemo(
    () => [...clubOptions.entries()].sort((first, second) => first[1].localeCompare(second[1])),
    [clubOptions],
  );
  const hasMore = page < totalPages;

  function submitFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters((current) => ({ ...current, search: searchDraft }));
  }

  function clearFilters() {
    setSearchDraft('');
    setFilters(emptyFilters);
  }

  return (
    <section>
      <div className="mb-8 max-w-3xl">
        <p className="eyebrow">Campus calendar</p>
        <h1 className="font-display mt-3 text-4xl font-black tracking-tight sm:text-5xl">
          {heading}
        </h1>
        <p className="mt-4 text-base leading-7 text-ink/70">{description}</p>
      </div>

      <RecommendedEvents />

      <form
        aria-label="Filter events"
        className="mb-8 grid gap-4 rounded-3xl border border-forest/10 bg-white p-5 shadow-card sm:grid-cols-2 lg:grid-cols-6 lg:p-6"
        onSubmit={submitFilters}
      >
        <label className="sm:col-span-2 lg:col-span-2">
          <span className="mb-1.5 block text-sm font-bold">Search events</span>
          <input
            autoComplete="off"
            className="field"
            maxLength={100}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Try a title or topic"
            type="search"
            value={searchDraft}
          />
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-bold">From</span>
          <input
            className="field"
            onChange={(event) =>
              setFilters((current) => ({ ...current, startDate: event.target.value }))
            }
            type="date"
            value={filters.startDate}
          />
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-bold">Through</span>
          <input
            className="field"
            onChange={(event) =>
              setFilters((current) => ({ ...current, endDate: event.target.value }))
            }
            type="date"
            value={filters.endDate}
          />
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-bold">Category</span>
          <select
            className="field"
            onChange={(event) =>
              setFilters((current) => ({ ...current, categoryId: event.target.value }))
            }
            value={filters.categoryId}
          >
            <option value="">All categories</option>
            {categories.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {!initialClubId && (
          <label>
            <span className="mb-1.5 block text-sm font-bold">Club</span>
            <select
              className="field"
              onChange={(event) =>
                setFilters((current) => ({ ...current, clubId: event.target.value }))
              }
              value={filters.clubId}
            >
              <option value="">All clubs</option>
              {clubs.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-6">
          <button
            className="rounded-full bg-forest px-5 py-2.5 text-sm font-bold text-white hover:bg-forest/90"
            type="submit"
          >
            Apply filters
          </button>
          <button
            className="rounded-full px-4 py-2.5 text-sm font-bold text-forest underline underline-offset-4"
            onClick={clearFilters}
            type="button"
          >
            Clear
          </button>
        </div>
      </form>

      {error && (
        <div
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-coral/30 bg-white p-4 text-sm text-coral"
          role="alert"
        >
          <p>{error}</p>
          <button
            className="font-bold underline underline-offset-4"
            onClick={() => void loadEvents(1, false)}
            type="button"
          >
            Try again
          </button>
        </div>
      )}

      <div aria-live="polite" className="sr-only" role="status">
        {loading ? 'Loading events.' : `${events.length} events loaded.`}
      </div>
      {events.length === 0 && !loading && !error ? (
        <div className="rounded-3xl border border-dashed border-forest/25 bg-white p-8 text-center">
          <h2 className="font-display text-2xl font-bold">No events match those filters</h2>
          <p className="mt-2 text-ink/70">Try another date or clear the search.</p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {events.map((event) => (
            <EventCard event={event} key={event.id} />
          ))}
        </div>
      )}

      <div aria-hidden="true" className="h-1" ref={sentinelRef} />
      {loading && (
        <p aria-live="polite" className="py-8 text-center font-semibold text-forest" role="status">
          Loading events…
        </p>
      )}
      {!loading && hasMore && (
        <div className="py-8 text-center">
          <button
            className="rounded-full border border-forest/30 bg-white px-6 py-3 font-bold text-forest hover:bg-mint/50"
            onClick={() => void loadEvents(page + 1, true)}
            type="button"
          >
            Load more events
          </button>
        </div>
      )}
    </section>
  );
}
