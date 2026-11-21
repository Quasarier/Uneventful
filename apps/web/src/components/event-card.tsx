import Link from 'next/link';
import { formatEventDate, type EventItem } from '@/lib/event-format';

export function EventCard({ event }: Readonly<{ event: EventItem }>) {
  return (
    <article className="group rounded-3xl border border-forest/10 bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-forest/30 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-mint/60 px-3 py-1 text-xs font-bold text-forest">
          {event.category.name}
        </span>
        <span className="text-xs font-medium text-ink/70">{event.club.name}</span>
      </div>
      <h2 className="font-display mt-4 text-2xl font-bold leading-tight">
        <Link
          className="rounded-sm decoration-forest/30 underline-offset-4 group-hover:underline focus-visible:outline"
          href={`/events/${event.id}`}
        >
          {event.title}
        </Link>
      </h2>
      <p className="mt-3 text-sm leading-6 text-ink/75">{event.description}</p>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-forest/10 pt-4 text-sm">
        <time dateTime={event.startAt}>{formatEventDate(event.startAt, event.timeZone)}</time>
        <span className="font-semibold text-forest">
          {event.capacity === null ? 'Open event' : `${event.capacity} spots`}
        </span>
      </div>
    </article>
  );
}
