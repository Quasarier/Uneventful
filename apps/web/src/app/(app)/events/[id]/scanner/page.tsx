import { CheckinScanner } from '@/components/checkin-scanner';

export default async function EventScannerPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  return <CheckinScanner eventId={id} />;
}
