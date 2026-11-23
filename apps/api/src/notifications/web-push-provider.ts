import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webPush from 'web-push';
import type { Environment } from '../config/environment';

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotificationPushPayload {
  title: string;
  eventName: string;
  link: string;
}

export interface PushProvider {
  send(
    subscription: PushSubscriptionData,
    payload: NotificationPushPayload,
    idempotencyKey: string,
  ): Promise<void>;
}

export const NOTIFICATION_PUSH_PROVIDER = Symbol('NOTIFICATION_PUSH_PROVIDER');

@Injectable()
export class VapidPushProvider implements PushProvider {
  private readonly configured: boolean;

  constructor(config: ConfigService<Environment, true>) {
    const publicKey = config.get('WEB_PUSH_VAPID_PUBLIC_KEY', { infer: true });
    const privateKey = config.get('WEB_PUSH_VAPID_PRIVATE_KEY', { infer: true });
    const subject = config.get('WEB_PUSH_VAPID_SUBJECT', { infer: true });
    this.configured = Boolean(publicKey && privateKey && subject);
    if (publicKey && privateKey && subject) {
      webPush.setVapidDetails(subject, publicKey, privateKey);
    }
  }

  async send(
    subscription: PushSubscriptionData,
    payload: NotificationPushPayload,
    idempotencyKey: string,
  ): Promise<void> {
    if (!this.configured) {
      throw new Error('Web Push is not configured.');
    }
    const topic = createHash('sha256').update(idempotencyKey).digest('base64url').slice(0, 32);
    await webPush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 3_600,
      urgency: 'normal',
      topic,
    });
  }
}
