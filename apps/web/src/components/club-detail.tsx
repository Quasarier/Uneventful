import { EventFeed } from '@/components/event-feed';

export function ClubDetail({
  clubId,
  slug,
}: Readonly<{
  clubId: string;
  slug: string;
}>) {
  const name = slug
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');

  return (
    <EventFeed
      description={`Upcoming public events from ${name}.`}
      heading={name || 'Club events'}
      initialClubId={clubId}
    />
  );
}
