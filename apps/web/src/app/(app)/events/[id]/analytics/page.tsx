import { EventAnalytics } from '@/components/event-analytics';

export default async function EventAnalyticsPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  return <EventAnalytics eventId={id} />;
}
