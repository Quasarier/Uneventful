import { ClubDetail } from '@/components/club-detail';

export default async function ClubDetailPage({
  params,
}: Readonly<{
  params: Promise<{ clubId: string; slug: string }>;
}>) {
  const { clubId, slug } = await params;
  return <ClubDetail clubId={clubId} slug={slug} />;
}
