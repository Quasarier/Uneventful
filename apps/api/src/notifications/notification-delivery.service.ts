import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  EventStatus,
  RsvpStatus,
  type Prisma,
} from '../../generated/prisma/client';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { NOTIFICATION_EMAIL_PROVIDER, type EmailProvider } from './email-provider';
import {
  NOTIFICATION_PUSH_PROVIDER,
  type NotificationPushPayload,
  type PushProvider,
  type PushSubscriptionData,
} from './web-push-provider';
import { buildNotificationEmail } from './notification-template';
import { UnsubscribeService } from './unsubscribe.service';
import { defaultNotificationPreference } from './notification.types';
import {
  isSafePushEndpoint,
  PushEndpointResolutionError,
  type PushHostLookup,
} from './push-endpoint';
import { PUSH_HOST_LOOKUP } from './notifications.service';
import { NOTIFICATION_DELIVERY_LEASE_MS } from './notification.constants';

const terminalStatuses = [
  NotificationDeliveryStatus.SENT,
  NotificationDeliveryStatus.SKIPPED,
  NotificationDeliveryStatus.DEAD_LETTERED,
  NotificationDeliveryStatus.CANCELLED,
];

type DeliveryRecord = Prisma.NotificationDeliveryGetPayload<{
  include: {
    notification: {
      include: {
        user: {
          select: { id: true; email: true; firstName: true; isActive: true; deletedAt: true };
        };
        event: {
          select: {
            id: true;
            title: true;
            status: true;
            startAt: true;
            venue: { select: { name: true; building: true } };
          };
        };
      };
    };
  };
}>;

function pushStatusCode(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
  ) {
    return error.statusCode;
  }
  return undefined;
}

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
    private readonly rateLimit: AuthRateLimitService,
    private readonly unsubscribe: UnsubscribeService,
    @Inject(NOTIFICATION_EMAIL_PROVIDER)
    private readonly emailProvider: EmailProvider,
    @Inject(NOTIFICATION_PUSH_PROVIDER)
    private readonly pushProvider: PushProvider,
    @Inject(PUSH_HOST_LOOKUP)
    private readonly hostLookup: PushHostLookup,
  ) {}

  async deliver(deliveryId: string): Promise<void> {
    const now = new Date();
    const claimed = await this.prisma.notificationDelivery.updateMany({
      where: {
        id: deliveryId,
        OR: [
          { status: NotificationDeliveryStatus.PENDING, availableAt: { lte: now } },
          {
            status: NotificationDeliveryStatus.PROCESSING,
            lockedAt: { lt: new Date(now.getTime() - NOTIFICATION_DELIVERY_LEASE_MS) },
          },
        ],
      },
      data: {
        status: NotificationDeliveryStatus.PROCESSING,
        lockedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return;
    }

    const delivery = await this.findDelivery(deliveryId);
    if (!delivery || !delivery.notification.user.isActive || delivery.notification.user.deletedAt) {
      await this.finish(deliveryId, NotificationDeliveryStatus.SKIPPED);
      return;
    }

    if (!(await this.isEnabled(delivery))) {
      await this.finish(deliveryId, NotificationDeliveryStatus.SKIPPED);
      return;
    }

    if (this.isReminder(delivery.notification.type) && !(await this.isReminderEligible(delivery))) {
      await this.finish(deliveryId, NotificationDeliveryStatus.SKIPPED);
      return;
    }

    let quota: { allowed: boolean; retryAfterMs: number };
    try {
      quota = await this.rateLimit.consumeNotificationQuota(
        delivery.notification.userId,
        this.config.get('NOTIFICATION_PER_USER_PER_HOUR', { infer: true }),
        this.config.get('NOTIFICATION_GLOBAL_PER_DAY', { infer: true }),
      );
    } catch (error) {
      await this.prisma.notificationDelivery.updateMany({
        where: { id: delivery.id, status: NotificationDeliveryStatus.PROCESSING },
        data: { status: NotificationDeliveryStatus.PENDING, lockedAt: null },
      });
      throw error;
    }
    if (!quota.allowed) {
      await this.prisma.notificationDelivery.updateMany({
        where: { id: delivery.id, status: NotificationDeliveryStatus.PROCESSING },
        data: {
          status: NotificationDeliveryStatus.PENDING,
          availableAt: new Date(Date.now() + Math.max(quota.retryAfterMs, 1_000)),
          lockedAt: null,
          attempts: { decrement: 1 },
        },
      });
      return;
    }

    try {
      if (delivery.channel === NotificationChannel.EMAIL) {
        await this.sendEmail(delivery);
      } else {
        const sent = await this.sendPush(delivery);
        if (!sent) {
          await this.finish(delivery.id, NotificationDeliveryStatus.SKIPPED);
          return;
        }
      }
    } catch {
      await this.prisma.notificationDelivery.updateMany({
        where: { id: delivery.id, status: NotificationDeliveryStatus.PROCESSING },
        data: { status: NotificationDeliveryStatus.PENDING, lockedAt: null },
      });
      throw new Error('Notification delivery failed.');
    }
    await this.finish(delivery.id, NotificationDeliveryStatus.SENT);
  }

  async markDeadLettered(deliveryId: string): Promise<void> {
    await this.prisma.notificationDelivery.updateMany({
      where: {
        id: deliveryId,
        status: { in: [NotificationDeliveryStatus.PENDING, NotificationDeliveryStatus.PROCESSING] },
      },
      data: { status: NotificationDeliveryStatus.DEAD_LETTERED, lockedAt: null },
    });
    this.logger.error('A notification delivery reached its retry limit.');
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { notificationId: true },
    });
    if (delivery) {
      await this.updateNotificationCompletion(delivery.notificationId);
    }
  }

  private async findDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
    return this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        notification: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                isActive: true,
                deletedAt: true,
              },
            },
            event: {
              select: {
                id: true,
                title: true,
                status: true,
                startAt: true,
                venue: { select: { name: true, building: true } },
              },
            },
          },
        },
      },
    });
  }

  private async isEnabled(delivery: DeliveryRecord): Promise<boolean> {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: {
        userId_channel_type: {
          userId: delivery.notification.userId,
          channel: delivery.channel,
          type: delivery.notification.type,
        },
      },
      select: { enabled: true },
    });
    return preference?.enabled ?? defaultNotificationPreference(delivery.channel);
  }

  private isReminder(type: NotificationType): boolean {
    return (
      type === NotificationType.EVENT_REMINDER_24H ||
      type === NotificationType.EVENT_REMINDER_1H ||
      type === NotificationType.EVENT_REMINDER
    );
  }

  private async isReminderEligible(delivery: DeliveryRecord): Promise<boolean> {
    const event = delivery.notification.event;
    if (!event || event.status !== EventStatus.APPROVED || event.startAt <= new Date()) {
      return false;
    }
    const rsvp = await this.prisma.rsvp.findUnique({
      where: {
        eventId_userId: {
          eventId: event.id,
          userId: delivery.notification.userId,
        },
      },
      select: { status: true },
    });
    return rsvp?.status === RsvpStatus.GOING;
  }

  private async sendEmail(delivery: DeliveryRecord): Promise<void> {
    const user = delivery.notification.user;
    const event = delivery.notification.event;
    const token = this.unsubscribe.createToken(user.id);
    const unsubscribeUrl = new URL(
      '/api/v1/unsubscribe',
      new URL(this.config.get('GOOGLE_CALLBACK_URL', { infer: true })).origin,
    );
    unsubscribeUrl.searchParams.set('token', token);
    const venueName = event?.venue
      ? [event.venue.name, event.venue.building].filter(Boolean).join(', ')
      : null;
    const email = buildNotificationEmail({
      to: user.email,
      firstName: user.firstName,
      eventId: event?.id ?? delivery.notification.eventId,
      eventName: event?.title ?? 'Campus event',
      venueName,
      type: delivery.notification.type,
      webOrigin: this.config.get('WEB_ORIGIN', { infer: true }),
      unsubscribeUrl: unsubscribeUrl.toString(),
    });
    await this.emailProvider.send(email, delivery.id);
  }

  private async sendPush(delivery: DeliveryRecord): Promise<boolean> {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId: delivery.notification.userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subscriptions.length === 0) {
      return false;
    }

    const event = delivery.notification.event;
    const payload: NotificationPushPayload = {
      title: 'CampusPulse update',
      eventName: event?.title ?? 'Campus event',
      link: event?.id ? `/events/${encodeURIComponent(event.id)}` : '/events',
    };
    let sent = false;
    for (const subscription of subscriptions) {
      let safe: boolean;
      try {
        safe = await isSafePushEndpoint(subscription.endpoint, this.hostLookup);
      } catch (error) {
        if (error instanceof PushEndpointResolutionError) {
          throw new Error('Push endpoint resolution failed.', { cause: error });
        }
        throw error;
      }
      if (!safe) {
        await this.prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
        continue;
      }

      const data: PushSubscriptionData = {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      };
      try {
        await this.pushProvider.send(data, payload, `${delivery.id}:${subscription.id}`);
        sent = true;
      } catch (error) {
        if (pushStatusCode(error) === 404 || pushStatusCode(error) === 410) {
          await this.prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
          continue;
        }
        throw new Error('Push notification delivery failed.', { cause: error });
      }
    }
    return sent;
  }

  private async finish(deliveryId: string, status: NotificationDeliveryStatus): Promise<void> {
    const updated = await this.prisma.notificationDelivery.updateMany({
      where: { id: deliveryId, status: NotificationDeliveryStatus.PROCESSING },
      data: {
        status,
        lockedAt: null,
        ...(status === NotificationDeliveryStatus.SENT ? { sentAt: new Date() } : {}),
      },
    });
    if (updated.count !== 1) {
      return;
    }
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { notificationId: true },
    });
    if (delivery) {
      await this.updateNotificationCompletion(delivery.notificationId);
    }
  }

  private async updateNotificationCompletion(notificationId: string): Promise<void> {
    const pending = await this.prisma.notificationDelivery.count({
      where: {
        notificationId,
        status: {
          notIn: [...terminalStatuses],
        },
      },
    });
    if (pending === 0) {
      await this.prisma.notification.updateMany({
        where: { id: notificationId, deliveredAt: null },
        data: { deliveredAt: new Date() },
      });
    }
  }
}
