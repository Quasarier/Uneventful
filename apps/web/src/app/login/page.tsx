import Link from 'next/link';
import { GoogleLogin } from '@/components/google-login';

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-12">
      <Link
        className="mb-8 w-fit text-sm font-bold text-forest underline underline-offset-4"
        href="/"
      >
        ← Uneventful
      </Link>
      <section className="rounded-3xl border border-forest/10 bg-white p-7 shadow-card sm:p-10">
        <p className="eyebrow">Welcome back</p>
        <h1 className="font-display mt-3 text-4xl font-black">Sign in to Uneventful</h1>
        <p className="mt-4 leading-7 text-ink/70">
          Use your university Google account to manage your events and tickets.
        </p>
        <div className="mt-7">
          <GoogleLogin />
        </div>
      </section>
    </main>
  );
}
