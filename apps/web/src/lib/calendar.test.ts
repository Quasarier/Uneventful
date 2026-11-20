import { describe, expect, it } from 'vitest';
import { createIcal } from './calendar';
import type { MyRsvp } from './event-format';

const rsvp: MyRsvp = {
  id: 'rsvp-1',
  status: 'GOING',
  waitlistPosition: null,
  createdAt: '2026-03-01T10:00:00.000Z',
  ticket: null,
  event: {
    id: 'event-1',
    title: 'Open, House; Night',
    slug: 'open-house',
    description: '<p>Bring snacks, please.</p>',
    status: 'APPROVED',
    startAt: '2026-04-02T18:00:00.000Z',
    endAt: '2026-04-02T20:00:00.000Z',
    timeZone: 'UTC',
    capacity: 50,
    isPublic: true,
    clubId: 'club-1',
    categoryId: 'category-1',
    rejectionReason: null,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z',
    hasImage: false,
    club: { name: 'Student, Union', slug: 'student-union' },
    category: { name: 'Social', slug: 'social' },
  },
};

describe('createIcal', () => {
  it('escapes event text and serializes event times as UTC', () => {
    const calendar = createIcal([rsvp], new Date('2026-03-01T10:00:00.000Z'));

    expect(calendar).toContain('DTSTART:20260402T180000Z');
    expect(calendar).toContain('SUMMARY:Open\\, House\\; Night');
    expect(calendar).toContain('DESCRIPTION:Bring snacks\\, please.');
    expect(calendar).toContain('LOCATION:Student\\, Union');
    expect(calendar).toMatch(/\r\n$/);
  });

  it('adds a waitlist label and folds long lines without splitting UTF-8 characters', () => {
    const longRsvp: MyRsvp = {
      ...rsvp,
      status: 'WAITLISTED',
      event: { ...rsvp.event, title: 'Café '.repeat(30) },
    };
    const calendar = createIcal([longRsvp]);
    const summaryLine = calendar.split('\r\n').find((line) => line.startsWith('SUMMARY:'));

    expect(calendar).toContain('SUMMARY:[Waitlist] Café');
    expect(summaryLine).toBeDefined();
    expect(new TextEncoder().encode(summaryLine ?? '').length).toBeLessThanOrEqual(75);
  });
});
