import { randomUUID } from 'node:crypto';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  type Prisma,
} from '../../generated/prisma/client';

type NotificationTransaction = Prisma.TransactionClient;

export interface EnqueueNotification {
  userId: string;
  eventId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  scheduledAt?: Date;
  dedupeKey: string;
}

export async function enqueueNotifications(
  transaction: NotificationTransaction,
  notifications: readonly EnqueueNotification[],
): Promise<void> {
  const rows = notifications.map((notification) => ({
    ...notification,
    id: randomUUID(),
    scheduledAt: notification.scheduledAt ?? new Date(),
  }));
  for (const notification of rows) {
    if (notification.dedupeKey.length > 180) {
      throw new Error('Notification dedupe key exceeds the database limit.');
    }
  }

  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    await transaction.notification.createMany({ data: batch, skipDuplicates: true });
    const stored = await transaction.notification.findMany({
      where: {
        dedupeKey: { in: batch.map(({ dedupeKey }) => dedupeKey) },
        deletedAt: null,
      },
      select: { id: true, scheduledAt: true },
    });
    await transaction.notificationDelivery.createMany({
      data: stored.flatMap(({ id, scheduledAt }) =>
        [NotificationChannel.EMAIL, NotificationChannel.PUSH].map((channel) => ({
          notificationId: id,
          channel,
          status: NotificationDeliveryStatus.PENDING,
          availableAt: scheduledAt,
        })),
      ),
      skipDuplicates: true,
    });
  }
}

export async function scheduleRsvpReminders(
  transaction: NotificationTransaction,
  input: {
    userId: string;
    eventId: string;
    rsvpId: string;
    eventTitle: string;
    startAt: Date;
    now?: Date;
  },
): Promise<void> {
  await enqueueNotifications(transaction, buildRsvpReminderNotifications(input));
}

export function buildRsvpReminderNotifications(input: {
  userId: string;
  eventId: string;
  rsvpId: string;
  eventTitle: string;
  startAt: Date;
  now?: Date;
}): EnqueueNotification[] {
  const now = input.now ?? new Date();
  const reminders = [
    { type: NotificationType.EVENT_REMINDER_24H, offsetMs: 24 * 60 * 60_000 },
    { type: NotificationType.EVENT_REMINDER_1H, offsetMs: 60 * 60_000 },
  ];
  return reminders
    .map(({ type, offsetMs }) => {
      const scheduledAt = new Date(input.startAt.getTime() - offsetMs);
      return {
        type,
        scheduledAt,
        userId: input.userId,
        eventId: input.eventId,
        title:
          type === NotificationType.EVENT_REMINDER_24H ? 'Event tomorrow' : 'Event in one hour',
        body: input.eventTitle,
        dedupeKey: `reminder:${input.rsvpId}:${type}:${input.startAt.getTime()}`,
      };
    })
    .filter(({ scheduledAt }) => scheduledAt > now);
}

export async function cancelPendingRsvpReminders(
  transaction: NotificationTransaction,
  eventId: string,
  userId?: string,
): Promise<void> {
  await transaction.notificationDelivery.updateMany({
    where: {
      status: { in: [NotificationDeliveryStatus.PENDING, NotificationDeliveryStatus.PROCESSING] },
      notification: {
        eventId,
        ...(userId ? { userId } : {}),
        type: {
          in: [NotificationType.EVENT_REMINDER_24H, NotificationType.EVENT_REMINDER_1H],
        },
      },
    },
    data: { status: NotificationDeliveryStatus.CANCELLED, lockedAt: null },
  });
}
