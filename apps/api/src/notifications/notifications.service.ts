import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationChannel,
  NotificationConsentAction,
  type NotificationType,
} from '../../generated/prisma/client';
import type { AuthPrincipal } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { MAX_PUSH_SUBSCRIPTIONS_PER_USER } from './notification.constants';
import { defaultNotificationPreference, NOTIFICATION_TYPES } from './notification.types';
import {
  isSafePushEndpoint,
  PushEndpointResolutionError,
  type PushHostLookup,
} from './push-endpoint';

export const PUSH_HOST_LOOKUP = Symbol('PUSH_HOST_LOOKUP');

export interface NotificationPreferenceChange {
  channel: NotificationChannel;
  type: NotificationType;
  enabled: boolean;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
    @Inject(PUSH_HOST_LOOKUP)
    private readonly hostLookup: PushHostLookup,
  ) {}

  async getPreferences(userId: string) {
    const [preferences, pushSubscriptionCount] = await Promise.all([
      this.prisma.notificationPreference.findMany({
        where: { userId },
        select: { channel: true, type: true, enabled: true },
      }),
      this.prisma.pushSubscription.count({ where: { userId } }),
    ]);
    const preferenceMap = new Map(
      preferences.map(({ channel, type, enabled }) => [`${channel}:${type}`, enabled]),
    );
    return {
      data: {
        preferences: [NotificationChannel.EMAIL, NotificationChannel.PUSH].flatMap((channel) =>
          NOTIFICATION_TYPES.map((type) => ({
            channel,
            type,
            enabled:
              preferenceMap.get(`${channel}:${type}`) ?? defaultNotificationPreference(channel),
          })),
        ),
        pushSubscriptionCount,
        vapidPublicKey: this.config.get('WEB_PUSH_VAPID_PUBLIC_KEY', { infer: true }) ?? null,
      },
    };
  }

  async updatePreferences(
    principal: AuthPrincipal,
    changes: readonly NotificationPreferenceChange[],
  ) {
    if (new Set(changes.map(({ channel, type }) => `${channel}:${type}`)).size !== changes.length) {
      throw new BadRequestException(
        'Each notification preference may be changed once per request.',
      );
    }

    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.notificationPreference.findMany({
        where: { userId: principal.id },
        select: { channel: true, type: true, enabled: true },
      });
      const preferenceMap = new Map(
        current.map(({ channel, type, enabled }) => [`${channel}:${type}`, enabled]),
      );
      for (const change of changes) {
        const key = `${change.channel}:${change.type}`;
        const previous = preferenceMap.get(key) ?? defaultNotificationPreference(change.channel);
        if (previous === change.enabled) {
          continue;
        }

        await transaction.notificationPreference.upsert({
          where: {
            userId_channel_type: {
              userId: principal.id,
              channel: change.channel,
              type: change.type,
            },
          },
          create: {
            userId: principal.id,
            channel: change.channel,
            type: change.type,
            enabled: change.enabled,
          },
          update: { enabled: change.enabled },
        });
        await transaction.notificationConsent.create({
          data: {
            userId: principal.id,
            channel: change.channel,
            type: change.type,
            action: change.enabled
              ? NotificationConsentAction.GRANTED
              : NotificationConsentAction.OPTED_OUT,
            source: 'SETTINGS',
          },
        });
        await transaction.auditLog.create({
          data: {
            actorId: principal.id,
            action: 'NOTIFICATION_PREFERENCE_CHANGED',
            entityType: 'NotificationPreference',
            metadata: {
              channel: change.channel,
              type: change.type,
              enabled: change.enabled,
            },
          },
        });
      }
    });
    return this.getPreferences(principal.id);
  }

  async addPushSubscription(principal: AuthPrincipal, input: PushSubscriptionInput): Promise<void> {
    let safe: boolean;
    try {
      safe = await isSafePushEndpoint(input.endpoint, this.hostLookup);
    } catch (error) {
      if (error instanceof PushEndpointResolutionError) {
        throw new ServiceUnavailableException(
          'Push endpoint validation is temporarily unavailable.',
        );
      }
      throw error;
    }
    if (!safe) {
      throw new BadRequestException('The push subscription is invalid.');
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "users"
        WHERE "id" = ${principal.id}::uuid AND "is_active" = TRUE AND "deleted_at" IS NULL
        FOR UPDATE
      `;
      const existing = await transaction.pushSubscription.findUnique({
        where: { endpoint: input.endpoint },
        select: { id: true, userId: true },
      });
      if (existing && existing.userId !== principal.id) {
        throw new BadRequestException('The push subscription is invalid.');
      }
      if (!existing) {
        const count = await transaction.pushSubscription.count({ where: { userId: principal.id } });
        if (count >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
          throw new BadRequestException('The push subscription limit has been reached.');
        }
      }

      await transaction.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: {
          userId: principal.id,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
        },
        update: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      });
      await transaction.auditLog.create({
        data: {
          actorId: principal.id,
          action: 'PUSH_SUBSCRIPTION_CREATED',
          entityType: 'PushSubscription',
          metadata: { channel: NotificationChannel.PUSH },
        },
      });
    });
  }

  async removePushSubscription(principal: AuthPrincipal, endpoint: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const removed = await transaction.pushSubscription.deleteMany({
        where: { userId: principal.id, endpoint },
      });
      if (removed.count > 0) {
        await transaction.auditLog.create({
          data: {
            actorId: principal.id,
            action: 'PUSH_SUBSCRIPTION_REMOVED',
            entityType: 'PushSubscription',
            metadata: { channel: NotificationChannel.PUSH },
          },
        });
      }
    });
  }
}
