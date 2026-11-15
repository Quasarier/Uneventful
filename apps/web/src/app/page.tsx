import Link from 'next/link';
import { GoogleLogin } from '@/components/google-login';

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-paper px-5 py-8 text-ink sm:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-32 -top-32 size-[28rem] rounded-full bg-mint/60 blur-3xl"
      />
      <header className="relative mx-auto flex max-w-7xl items-center justify-between">
        <Link aria-label="CampusPulse home" className="flex items-center gap-3" href="/">
          <span
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-2xl bg-forest text-mint"
          >
            <svg aria-hidden="true" fill="none" height="22" viewBox="0 0 32 22" width="32">
              <path
                d="M1 12h7l4-9 8 17 5-11 3 3h3"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.5"
              />
            </svg>
          </span>
          <span className="font-display text-xl font-black tracking-tight">CampusPulse</span>
        </Link>
        <Link
          className="rounded-full px-4 py-2 text-sm font-bold text-forest underline decoration-forest/30 underline-offset-4 hover:decoration-forest"
          href="/events"
        >
          Browse events
        </Link>
      </header>
      <section className="relative mx-auto grid min-h-[calc(100vh-7rem)] max-w-7xl items-center gap-12 py-16 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="max-w-2xl">
          <p className="eyebrow">Campus life, in sync</p>
          <h1 className="font-display mt-5 text-5xl font-black leading-[1.05] tracking-tight sm:text-7xl">
            Find your next <span className="text-forest">favorite</span> thing.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-ink/75">
            Discover events, meet your campus community, and keep every ticket in one place.
          </p>
          <div className="mt-9 max-w-sm rounded-3xl border border-forest/10 bg-white p-6 shadow-card sm:p-8">
            <h2 className="font-display text-2xl font-bold">
              Sign in with your university account
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink/70">
              Use your campus Google account to RSVP and manage your tickets.
            </p>
            <div className="mt-6">
              <GoogleLogin />
            </div>
          </div>
        </div>
        <div
          aria-label="Campus events are better together"
          className="relative hidden min-h-[28rem] items-center justify-center lg:flex"
          role="img"
        >
          <div className="absolute size-[25rem] rounded-full border border-forest/15" />
          <div className="absolute size-[19rem] rounded-full border border-forest/15" />
          <div className="relative grid size-56 place-items-center rounded-[3rem] bg-forest text-mint shadow-card">
            <svg aria-hidden="true" fill="none" height="108" viewBox="0 0 128 90" width="154">
              <path
                d="M4 47h28l15-34 31 68 19-44 12 16h15"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="8"
              />
            </svg>
          </div>
          <div className="absolute left-[8%] top-[16%] -rotate-6 rounded-2xl bg-white px-5 py-4 shadow-card">
            <p className="eyebrow">This week</p>
            <p className="mt-1 font-bold">Find your people</p>
          </div>
          <div className="absolute bottom-[14%] right-[4%] rotate-3 rounded-2xl bg-mint px-5 py-4 shadow-card">
            <p className="eyebrow">Your next plan</p>
            <p className="mt-1 font-bold">Starts on campus</p>
          </div>
        </div>
      </section>
    </main>
  );
}
