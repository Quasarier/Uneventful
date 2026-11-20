'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/components/auth-provider';

const navigation = [
  { href: '/events', label: 'Events' },
  { href: '/clubs', label: 'Clubs' },
  { href: '/tickets', label: 'Tickets' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/profile', label: 'Profile' },
];

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const { logout, userRole } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');

  async function signOut() {
    setError('');
    try {
      await logout();
      router.replace('/login');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-out failed.');
    }
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="border-b border-forest/10 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <Link aria-label="Uneventful home" className="flex items-center gap-3" href="/events">
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-2xl bg-forest text-mint"
            >
              <PulseMark />
            </span>
            <span className="font-display text-xl font-black tracking-tight">Uneventful</span>
          </Link>
          <nav
            aria-label="Primary navigation"
            className="flex items-center gap-1 overflow-x-auto pb-1 lg:pb-0"
          >
            {navigation
              .filter(
                (item) => userRole === 'STUDENT' || !['/tickets', '/calendar'].includes(item.href),
              )
              .map((item) => (
                <Link
                  className="whitespace-nowrap rounded-full px-3 py-2 text-sm font-semibold text-ink/75 transition hover:bg-paper hover:text-forest focus-visible:outline"
                  href={item.href}
                  key={item.href}
                >
                  {item.label}
                </Link>
              ))}
            <button
              className="whitespace-nowrap rounded-full border border-forest/20 px-3 py-2 text-sm font-semibold text-forest transition hover:bg-forest hover:text-white focus-visible:outline"
              onClick={() => void signOut()}
              type="button"
            >
              Sign out
            </button>
          </nav>
        </div>
        {error && (
          <p
            className="mx-auto max-w-7xl px-4 pb-3 text-sm text-coral sm:px-6 lg:px-8"
            role="alert"
          >
            {error}
          </p>
        )}
      </header>
      <main
        className="mx-auto min-h-[calc(100vh-7rem)] max-w-7xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8"
        id="main-content"
      >
        {children}
      </main>
      <footer className="border-t border-forest/10 bg-white px-4 py-6 text-center text-sm text-ink/65">
        Made for campus life.
      </footer>
    </div>
  );
}

function PulseMark() {
  return (
    <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 32 22" width="32">
      <path
        d="M1 12h7l4-9 8 17 5-11 3 3h3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.5"
      />
    </svg>
  );
}
