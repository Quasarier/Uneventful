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
    const physicalLines = calendar.trimEnd().split('\r\n');
    const summaryLine = physicalLines.find((line) => line.startsWith('SUMMARY:'));

    expect(calendar).toContain('SUMMARY:[Waitlist] Café');
    expect(summaryLine).toBeDefined();
    for (const line of physicalLines) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(physicalLines.some((line) => line.startsWith(' '))).toBe(true);
  });

  it('escapes hostile delimiters and line breaks so event text cannot inject calendar properties', () => {
    const hostileRsvp: MyRsvp = {
      ...rsvp,
      event: {
        ...rsvp.event,
        title: 'Title\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nX-ATTACK:1,;\\tail',
        description: 'Description\nEND:VCALENDAR\rX-ATTACK:2,;\\tail',
      },
    };
    const calendar = createIcal([hostileRsvp]);
    const physicalLines = calendar.trimEnd().split('\r\n');
    const unfolded = calendar.replace(/\r\n /g, '');

    expect(physicalLines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(physicalLines.filter((line) => line === 'END:VEVENT')).toHaveLength(1);
    expect(physicalLines.filter((line) => line === 'END:VCALENDAR')).toHaveLength(1);
    expect(unfolded).toContain(
      'SUMMARY:Title\\nEND:VEVENT\\nBEGIN:VEVENT\\nX-ATTACK:1\\,\\;\\\\tail',
    );
    expect(unfolded).toContain(
      'DESCRIPTION:Description\\nEND:VCALENDAR\\nX-ATTACK:2\\,\\;\\\\tail',
    );
    for (const line of physicalLines) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});
