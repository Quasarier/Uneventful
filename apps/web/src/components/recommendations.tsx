'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import type { components } from '@/lib/api-schema';

type RecommendationList = components['schemas']['Recommendations'];

export function RecommendedEvents() {
  const { accessToken, userRole } = useAuth();
  const [recommendations, setRecommendations] = useState<RecommendationList | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!accessToken || userRole !== 'STUDENT') return;
    try {
      const {
        data,
        error: responseError,
        response,
      } = await createApiClient(accessToken).GET('/recommendations', { cache: 'no-store' });
      if (!response.ok || !data) {
        throw new Error(errorMessage(responseError, 'Recommendations could not be loaded.'));
      }
      setRecommendations(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Recommendations could not be loaded.');
    }
  }, [accessToken, userRole]);

  useEffect(() => {
    setRecommendations(null);
    setError('');
    void load();
  }, [load]);

  if (userRole !== 'STUDENT' || (!recommendations && !error)) return null;
  return (
    <section
      aria-labelledby="recommendations-heading"
      className="mb-8 rounded-3xl bg-white p-5 shadow-card"
    >
      <h2 className="font-display text-2xl font-bold" id="recommendations-heading">
        Recommended for you
      </h2>
      {error && (
        <p className="mt-3 text-sm text-coral" role="status">
          {error}
        </p>
      )}
      {recommendations && (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {recommendations.data.map(({ event, reason }) => (
            <li className="rounded-2xl border border-forest/10 p-4" key={event.id}>
              <Link className="font-bold text-forest underline" href={`/events/${event.id}`}>
                {event.title}
              </Link>
              <p className="mt-1 text-sm text-ink/70">
                {event.club.name} · {new Date(event.startAt).toLocaleString()}
              </p>
              <p className="mt-2 text-sm">{reason}</p>
            </li>
          ))}
          {recommendations.data.length === 0 && (
            <li className="text-sm text-ink/70">No upcoming recommendations are available.</li>
          )}
        </ul>
      )}
    </section>
  );
}

export function RecommendationSettings() {
  const { accessToken, userRole } = useAuth();
  const [personalized, setPersonalized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!accessToken || userRole !== 'STUDENT') {
      setLoading(false);
      return;
    }
    try {
      const { data, response } = await createApiClient(accessToken).GET(
        '/me/recommendation-preference',
        { cache: 'no-store' },
      );
      if (!response.ok || !data) throw new Error('Personalization settings could not be loaded.');
      setPersonalized(data.personalized);
    } catch {
      setMessage('Personalization settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [accessToken, userRole]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(nextValue: boolean) {
    if (!accessToken) return;
    setSaving(true);
    setMessage('');
    try {
      const { data, response } = await createApiClient(accessToken).PATCH(
        '/me/recommendation-preference',
        { body: { personalized: nextValue } },
      );
      if (!response.ok || !data) throw new Error('The personalization setting could not be saved.');
      setPersonalized(data.personalized);
      setMessage('Your preference has been saved.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'The preference could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteDerivedData() {
    if (!accessToken) return;
    setSaving(true);
    setMessage('');
    try {
      const { response } = await createApiClient(accessToken).DELETE('/me/recommendation-data');
      if (!response.ok) throw new Error('Derived recommendation data could not be deleted.');
      setMessage('Derived recommendation data was deleted.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Derived data could not be deleted.');
    } finally {
      setSaving(false);
    }
  }

  if (userRole !== 'STUDENT') return null;
  return (
    <section
      aria-labelledby="personalization-heading"
      className="mt-6 rounded-3xl bg-white p-6 shadow-card"
    >
      <h2 className="font-display text-2xl font-bold" id="personalization-heading">
        Event recommendations
      </h2>
      <p className="mt-2 text-sm text-ink/70">
        Personalization uses your own past attendance and followed clubs. Turn it off to see popular
        upcoming events without using your attendance history.
      </p>
      <label className="mt-4 flex items-center gap-3 font-semibold">
        <input
          checked={personalized}
          className="size-5 accent-forest"
          disabled={loading || saving}
          onChange={(event) => void save(event.target.checked)}
          type="checkbox"
        />
        Use my activity to personalize recommendations
      </label>
      <button
        className="mt-4 rounded-full border border-forest/25 px-4 py-2 text-sm font-bold text-forest disabled:opacity-60"
        disabled={saving}
        onClick={() => void deleteDerivedData()}
        type="button"
      >
        Delete derived recommendation data
      </button>
      {message && (
        <p aria-live="polite" className="mt-3 text-sm" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
