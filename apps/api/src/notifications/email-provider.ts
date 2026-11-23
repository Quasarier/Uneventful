import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';

export interface NotificationEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export interface EmailProvider {
  send(email: NotificationEmail, idempotencyKey: string): Promise<void>;
}

export const NOTIFICATION_EMAIL_PROVIDER = Symbol('NOTIFICATION_EMAIL_PROVIDER');

@Injectable()
export class LocalEmailProvider implements EmailProvider {
  readonly messages: Array<{ email: NotificationEmail; idempotencyKey: string }> = [];

  async send(email: NotificationEmail, idempotencyKey: string): Promise<void> {
    if (!this.messages.some((message) => message.idempotencyKey === idempotencyKey)) {
      this.messages.push({ email: structuredClone(email), idempotencyKey });
    }
  }
}

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async send(email: NotificationEmail, idempotencyKey: string): Promise<void> {
    const apiKey = this.config.get('NOTIFICATION_EMAIL_API_KEY', { infer: true });
    const from = this.config.get('NOTIFICATION_EMAIL_FROM_ADDRESS', { infer: true });
    if (!apiKey || !from) {
      throw new Error('Email provider is not configured.');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: email.headers,
      }),
    });
    if (!response.ok) {
      throw new Error('The configured email provider rejected the notification.');
    }
  }
}
