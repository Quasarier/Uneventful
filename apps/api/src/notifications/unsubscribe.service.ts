import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel, NotificationConsentAction } from '../../generated/prisma/client';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { NOTIFICATION_TYPES } from './notification.types';

interface UnsubscribeClaims {
  purpose: 'email-unsubscribe';
  channel: 'EMAIL';
  userId: string;
  expiresAt: number;
}

function isUnsubscribeClaims(value: unknown): value is UnsubscribeClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    Object.keys(claims).length === 4 &&
    claims.purpose === 'email-unsubscribe' &&
    claims.channel === NotificationChannel.EMAIL &&
    typeof claims.userId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      claims.userId,
    ) &&
    typeof claims.expiresAt === 'number' &&
    Number.isSafeInteger(claims.expiresAt) &&
    claims.expiresAt > Math.floor(Date.now() / 1000)
  );
}

@Injectable()
export class UnsubscribeService {
  private readonly signingKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Environment, true>,
  ) {
    const secret = config.get('NOTIFICATION_UNSUBSCRIBE_SECRET', { infer: true });
    this.signingKey = Buffer.from(secret ?? randomBytes(32));
  }

  createToken(userId: string): string {
    const claims: UnsubscribeClaims = {
      purpose: 'email-unsubscribe',
      channel: 'EMAIL',
      userId,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    };
    const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', this.signingKey)
      .update(encodedClaims)
      .digest('base64url');
    return `${encodedClaims}.${signature}`;
  }

  async unsubscribe(token: string): Promise<void> {
    const claims = this.verify(token);
    if (!claims) {
      return;
    }

    await this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id: claims.userId, deletedAt: null },
        select: { id: true },
      });
      if (!user) {
        return;
      }

      const existing = await transaction.notificationPreference.findMany({
        where: {
          userId: user.id,
          channel: NotificationChannel.EMAIL,
          type: { in: [...NOTIFICATION_TYPES] },
        },
        select: { type: true, enabled: true },
      });
      const current = new Map(existing.map(({ type, enabled }) => [type, enabled]));
      const changedTypes = NOTIFICATION_TYPES.filter((type) => current.get(type) !== false);

      await transaction.notificationPreference.createMany({
        data: NOTIFICATION_TYPES.map((type) => ({
          userId: user.id,
          channel: NotificationChannel.EMAIL,
          type,
          enabled: false,
        })),
        skipDuplicates: true,
      });
      await transaction.notificationPreference.updateMany({
        where: {
          userId: user.id,
          channel: NotificationChannel.EMAIL,
          type: { in: [...NOTIFICATION_TYPES] },
        },
        data: { enabled: false },
      });

      if (changedTypes.length > 0) {
        await transaction.notificationConsent.createMany({
          data: changedTypes.map((type) => ({
            userId: user.id,
            channel: NotificationChannel.EMAIL,
            type,
            action: NotificationConsentAction.OPTED_OUT,
            source: 'ONE_CLICK',
          })),
        });
        await transaction.auditLog.create({
          data: {
            actorId: user.id,
            action: 'NOTIFICATION_UNSUBSCRIBED',
            entityType: 'User',
            entityId: user.id,
            metadata: { channel: NotificationChannel.EMAIL, source: 'ONE_CLICK' },
          },
        });
      }
    });
  }

  private verify(token: string): UnsubscribeClaims | null {
    if (token.length > 1024) {
      return null;
    }
    const [encodedClaims, encodedSignature, ...extra] = token.split('.');
    if (!encodedClaims || !encodedSignature || extra.length > 0) {
      return null;
    }

    const expected = createHmac('sha256', this.signingKey).update(encodedClaims).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(encodedSignature, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return null;
    }

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!isUnsubscribeClaims(claims)) {
      return null;
    }
    return claims;
  }
}
