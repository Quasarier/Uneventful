'use client';

import dynamic from 'next/dynamic';
import { useAuth } from '@/components/auth-provider';

const AdminConsole = dynamic(() => import('@/components/admin-console'), {
  loading: () => <p role="status">Loading administrator tools…</p>,
  ssr: false,
});

export function AdminGate() {
  const { userRole } = useAuth();

  if (userRole !== 'ADMIN') {
    return (
      <main className="mx-auto max-w-3xl rounded-3xl bg-white p-8 shadow-card">
        <h1 className="font-display text-2xl font-black">Page not found</h1>
      </main>
    );
  }
  return <AdminConsole />;
}
