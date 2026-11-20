import { AppGate } from '@/components/app-gate';
import { AppShell } from '@/components/app-shell';

export default function AuthenticatedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AppGate>
      <AppShell>{children}</AppShell>
    </AppGate>
  );
}
