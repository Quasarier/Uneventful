import { describe, expect, it } from 'vitest';
import { NotificationType } from '../../generated/prisma/client';
import { buildNotificationEmail, escapeHtml, safeHeaderValue } from './notification-template';

describe('notification templates', () => {
  it('escapes event titles, attendee names, and venues in HTML and uses only configured-origin links', () => {
    const email = buildNotificationEmail({
      to: 'student@example.edu',
      firstName: '<img src=x onerror=alert(1)>',
      eventId: '32bb590f-f720-4f4a-9b14-2a50764234c5',
      eventName: '<script>alert(1)</script>',
      venueName: 'Hall <b>One</b>',
      type: NotificationType.RSVP_CONFIRMED,
      webOrigin: 'https://campus.example.edu',
      unsubscribeUrl: 'https://api.example.edu/api/v1/unsubscribe?token=abc',
    });

    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.html).toContain('Hall &lt;b&gt;One&lt;/b&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('href="https://campus.example.edu/events/');
    expect(email.text).toContain('https://campus.example.edu/events/');
    expect(email.text).not.toContain('student@example.edu');
  });

  it('strips line breaks from subject and header values', () => {
    expect(safeHeaderValue('Event\r\nBcc: attacker@example.edu')).toBe(
      'Event Bcc: attacker@example.edu',
    );
    const email = buildNotificationEmail({
      to: 'student@example.edu',
      firstName: 'Student',
      eventId: null,
      eventName: 'Show\r\nBcc: attacker@example.edu',
      venueName: null,
      type: NotificationType.EVENT_UPDATED,
      webOrigin: 'https://campus.example.edu',
      unsubscribeUrl: 'https://api.example.edu/api/v1/unsubscribe?token=abc',
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(Object.values(email.headers).join('')).not.toMatch(/[\r\n]/);
  });

  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
