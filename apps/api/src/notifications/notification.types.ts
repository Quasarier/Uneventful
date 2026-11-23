import { NotificationChannel, NotificationType } from '../../generated/prisma/client';

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.EVENT_SUBMITTED,
  NotificationType.EVENT_APPROVED,
  NotificationType.EVENT_REJECTED,
  NotificationType.EVENT_CANCELLED,
  NotificationType.EVENT_UPDATED,
  NotificationType.RSVP_CONFIRMED,
  NotificationType.RSVP_CANCELLED,
  NotificationType.WAITLISTED,
  NotificationType.EVENT_REMINDER,
  NotificationType.EVENT_REMINDER_24H,
  NotificationType.EVENT_REMINDER_1H,
  NotificationType.VENUE_BOOKING_UPDATED,
];

export function defaultNotificationPreference(channel: NotificationChannel): boolean {
  return channel === 'EMAIL';
}
