import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateOccurrences, intervalsConflict, isWithinAvailability } from './venue-time';

describe('venue booking time rules', () => {
  it('keeps buffered interval conflicts symmetric for generated valid intervals', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 1_440 }),
        (leftStart, leftDuration, rightStart, rightDuration, bufferMinutes) => {
          const leftStartAt = new Date(leftStart * 60_000);
          const leftEndAt = new Date((leftStart + leftDuration) * 60_000);
          const rightStartAt = new Date(rightStart * 60_000);
          const rightEndAt = new Date((rightStart + rightDuration) * 60_000);

          expect(
            intervalsConflict(leftStartAt, leftEndAt, rightStartAt, rightEndAt, bufferMinutes),
          ).toBe(
            intervalsConflict(rightStartAt, rightEndAt, leftStartAt, leftEndAt, bufferMinutes),
          );
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('allows exactly the configured buffer between slots', () => {
    expect(
      intervalsConflict(
        new Date('2027-01-01T10:00:00.000Z'),
        new Date('2027-01-01T11:00:00.000Z'),
        new Date('2027-01-01T11:15:00.000Z'),
        new Date('2027-01-01T12:00:00.000Z'),
        15,
      ),
    ).toBe(false);
  });

  it('keeps weekly occurrences at the same campus wall time across DST', () => {
    const occurrences = generateOccurrences(
      new Date('2027-03-07T14:00:00.000Z'),
      new Date('2027-03-07T15:00:00.000Z'),
      { frequency: 'WEEKLY', interval: 1, count: 3 },
      [],
      'America/New_York',
    );

    expect(occurrences.map(({ startAt }) => startAt.toISOString())).toEqual([
      '2027-03-07T14:00:00.000Z',
      '2027-03-14T13:00:00.000Z',
      '2027-03-21T13:00:00.000Z',
    ]);
  });

  it('checks venue opening hours in the campus zone on both sides of DST', () => {
    const availability = [{ weekday: 7, opensAt: '08:00', closesAt: '18:00' }];

    expect(
      isWithinAvailability(
        new Date('2027-03-07T14:00:00.000Z'),
        new Date('2027-03-07T15:00:00.000Z'),
        availability,
        'America/New_York',
      ),
    ).toBe(true);
    expect(
      isWithinAvailability(
        new Date('2027-03-14T13:00:00.000Z'),
        new Date('2027-03-14T14:00:00.000Z'),
        availability,
        'America/New_York',
      ),
    ).toBe(true);
  });

  it('omits exception dates and enforces the hard occurrence cap', () => {
    const occurrences = generateOccurrences(
      new Date('2027-01-04T15:00:00.000Z'),
      new Date('2027-01-04T16:00:00.000Z'),
      { frequency: 'WEEKLY', interval: 1, count: 3 },
      ['2027-01-11'],
      'America/New_York',
    );

    expect(occurrences.map(({ occurrenceIndex }) => occurrenceIndex)).toEqual([0, 2]);
    expect(() =>
      generateOccurrences(
        new Date('2027-01-04T15:00:00.000Z'),
        new Date('2027-01-04T16:00:00.000Z'),
        { frequency: 'DAILY', interval: 1, untilDate: '2028-01-01' },
        [],
        'America/New_York',
      ),
    ).toThrow(/52 occurrences/);
  });
});
