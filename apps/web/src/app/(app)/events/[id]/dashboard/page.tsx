import { EventDashboard } from '@/components/event-dashboard';

export default async function EventDashboardPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  return <EventDashboard eventId={id} />;
}
