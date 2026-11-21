'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import type { UserProfile as ProfileData } from '@/lib/event-format';

export function Profile() {
  const { accessToken } = useAuth();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function loadProfile() {
      if (!accessToken) {
        setError('Your session has expired. Sign in again to continue.');
        setLoading(false);
        return;
      }
      try {
        const {
          data,
          error: responseError,
          response,
        } = await createApiClient(accessToken).GET('/auth/me');
        if (!response.ok || !data) {
          throw new Error(errorMessage(responseError, 'Your profile could not be loaded.'));
        }
        if (active) setProfile(data);
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Your profile could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadProfile();
    return () => {
      active = false;
    };
  }, [accessToken]);

  if (loading) {
    return (
      <p aria-live="polite" className="py-8 font-semibold text-forest" role="status">
        Loading your profile…
      </p>
    );
  }
  if (error || !profile) {
    return (
      <p className="rounded-2xl bg-white p-5 text-coral" role="alert">
        {error || 'Your profile is unavailable.'}
      </p>
    );
  }

  const initials = `${profile.firstName.charAt(0)}${profile.lastName.charAt(0)}`.toUpperCase();

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-8">
        <p className="eyebrow">Your campus account</p>
        <h1 className="font-display mt-3 text-4xl font-black tracking-tight sm:text-5xl">
          Profile
        </h1>
      </div>
      <div className="rounded-3xl border border-forest/10 bg-white p-6 shadow-card sm:p-8">
        <div className="flex items-center gap-5 border-b border-forest/10 pb-6">
          <div
            aria-hidden="true"
            className="grid size-16 place-items-center rounded-full bg-mint text-xl font-black text-forest"
          >
            {initials}
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold">
              {profile.firstName} {profile.lastName}
            </h2>
            <p className="mt-1 text-sm text-ink/70">{profile.role.toLowerCase()}</p>
          </div>
        </div>
        <dl className="grid gap-5 pt-6 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold uppercase tracking-wider text-ink/70">
              University email
            </dt>
            <dd className="mt-1 break-all font-semibold">{profile.email}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wider text-ink/70">Account role</dt>
            <dd className="mt-1 font-semibold">{profile.role}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
