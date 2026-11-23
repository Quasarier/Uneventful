import { NotificationType } from '../../generated/prisma/client';
import type { NotificationEmail } from './email-provider';

interface NotificationEmailInput {
  to: string;
  firstName: string;
  eventId: string | null;
  eventName: string;
  venueName: string | null;
  type: NotificationType;
  webOrigin: string;
  unsubscribeUrl: string;
}

const subjectByType: Partial<Record<NotificationType, string>> = {
  EVENT_APPROVED: 'Event approved',
  EVENT_REJECTED: 'Event decision',
  EVENT_CANCELLED: 'Event cancelled',
  EVENT_UPDATED: 'Event updated',
  RSVP_CONFIRMED: 'RSVP confirmed',
  RSVP_CANCELLED: 'RSVP cancelled',
  WAITLISTED: 'Waitlist update',
  EVENT_REMINDER_24H: 'Event reminder',
  EVENT_REMINDER_1H: 'Event reminder',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function safeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function buildNotificationEmail(input: NotificationEmailInput): NotificationEmail {
  const action = subjectByType[input.type] ?? 'Campus event update';
  const subject = safeHeaderValue(`${action}: ${input.eventName}`);
  const eventPath = input.eventId ? `/events/${encodeURIComponent(input.eventId)}` : '/events';
  const eventUrl = new URL(eventPath, input.webOrigin).toString();
  const venueLine = input.venueName ? `Venue: ${input.venueName}` : '';
  const text = [
    `Hi ${input.firstName},`,
    '',
    `${action}: ${input.eventName}`,
    venueLine,
    `View event: ${eventUrl}`,
    '',
    `Manage email preferences: ${input.unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join('\n');
  const html = [
    '<!doctype html><html><body>',
    `<p>Hi ${escapeHtml(input.firstName)},</p>`,
    `<p><strong>${escapeHtml(action)}:</strong> ${escapeHtml(input.eventName)}</p>`,
    input.venueName ? `<p>Venue: ${escapeHtml(input.venueName)}</p>` : '',
    `<p><a href="${escapeHtml(eventUrl)}">View event</a></p>`,
    `<p><a href="${escapeHtml(input.unsubscribeUrl)}">Unsubscribe from email notifications</a></p>`,
    '</body></html>',
  ].join('');
  return {
    to: input.to,
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${safeHeaderValue(input.unsubscribeUrl)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
