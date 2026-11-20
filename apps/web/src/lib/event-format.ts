import type { components } from '@/lib/api-schema';

export type EventItem = components['schemas']['Event'];
export type MyRsvp = components['schemas']['MyRsvp'];
export type UserProfile = components['schemas']['UserProfile'];

export function formatEventDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(value));
}

export function eventIsPast(event: EventItem, now = Date.now()): boolean {
  return new Date(event.endAt).getTime() <= now;
}
