'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';

export function AppGate({ children }: Readonly<{ children: React.ReactNode }>) {
  const { accessToken, ensureSession, setUserRole } = useAuth();
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!accessToken) {
      void ensureSession()
        .then((isAuthenticated) => {
          if (active && !isAuthenticated) router.replace('/login');
        })
        .catch(() => {
          if (active) {
            setError('Your session could not be checked. Please try again.');
            setChecking(false);
          }
        });
      return () => {
        active = false;
      };
    }

    void createApiClient(accessToken)
      .GET('/auth/me')
      .then(({ data, response }) => {
        if (!active) return;
        if (!response.ok || !data) {
          setUserRole(null);
          router.replace('/login');
          return;
        }
        setUserRole(data.role);
        setError('');
        setChecking(false);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason, 'Your profile could not be checked.'));
          setChecking(false);
        }
      });
    return () => {
      active = false;
    };
  }, [accessToken, ensureSession, router, setUserRole]);

  if (checking || !accessToken || error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
        <div
          aria-live={error ? 'assertive' : 'polite'}
          className="rounded-3xl bg-white p-8 shadow-card"
          role={error ? 'alert' : 'status'}
        >
          <p className="eyebrow">CampusPulse</p>
          <p className="mt-3 text-lg font-semibold">{error || 'Checking your secure session…'}</p>
          {error ? (
            <button
              className="mt-4 text-sm font-bold text-forest underline"
              onClick={() => window.location.reload()}
              type="button"
            >
              Try again
            </button>
          ) : (
            <Link
              className="mt-4 inline-block text-sm font-bold text-forest underline"
              href="/login"
            >
              Go to sign in
            </Link>
          )}
        </div>
      </main>
    );
  }

  return children;
}
