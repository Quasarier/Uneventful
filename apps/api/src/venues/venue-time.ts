import { Temporal } from '@js-temporal/polyfill';

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface AvailabilityWindow {
  weekday: number;
  opensAt: string;
  closesAt: string;
}

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  count?: number;
  untilDate?: string;
}

export interface EventOccurrence {
  occurrenceIndex: number;
  startAt: Date;
  endAt: Date;
}

const MAX_RECURRENCES = 52;
const MINUTES_PER_DAY = 24 * 60;

export function intervalsConflict(
  leftStart: Date,
  leftEnd: Date,
  rightStart: Date,
  rightEnd: Date,
  bufferMinutes: number,
): boolean {
  const bufferMs = bufferMinutes * 60_000;
  return (
    leftStart.getTime() < rightEnd.getTime() + bufferMs &&
    leftEnd.getTime() + bufferMs > rightStart.getTime()
  );
}

export function isWithinAvailability(
  startAt: Date,
  endAt: Date,
  availability: AvailabilityWindow[],
  timeZone: string,
): boolean {
  if (endAt <= startAt) {
    return false;
  }

  const localStart = Temporal.Instant.from(startAt.toISOString()).toZonedDateTimeISO(timeZone);
  const localEnd = Temporal.Instant.from(endAt.toISOString()).toZonedDateTimeISO(timeZone);
  if (!localStart.toPlainDate().equals(localEnd.toPlainDate())) {
    return false;
  }

  const window = availability.find(({ weekday }) => weekday === localStart.dayOfWeek);
  if (!window) {
    return false;
  }

  const openingMinute = parseClockTime(window.opensAt);
  const closingMinute = parseClockTime(window.closesAt);
  const startMinute = localStart.hour * 60 + localStart.minute + localStart.second / 60;
  const endMinute = localEnd.hour * 60 + localEnd.minute + localEnd.second / 60;
  return (
    openingMinute !== null &&
    closingMinute !== null &&
    closingMinute > openingMinute &&
    startMinute >= openingMinute &&
    endMinute <= closingMinute
  );
}

export function generateOccurrences(
  startAt: Date,
  endAt: Date,
  rule: RecurrenceRule,
  exceptionDates: string[],
  timeZone: string,
): EventOccurrence[] {
  if (endAt <= startAt || !Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new RangeError('Invalid event recurrence range.');
  }
  if ((rule.count === undefined) === (rule.untilDate === undefined)) {
    throw new RangeError('Specify exactly one recurrence count or end date.');
  }
  if (
    (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1)) ||
    (rule.count !== undefined && rule.count > MAX_RECURRENCES)
  ) {
    throw new RangeError('The recurrence count exceeds the supported range.');
  }

  const untilDate = rule.untilDate ? Temporal.PlainDate.from(rule.untilDate) : undefined;
  const excludedDates = new Set(exceptionDates);
  const durationMs = endAt.getTime() - startAt.getTime();
  const first = Temporal.Instant.from(startAt.toISOString()).toZonedDateTimeISO(timeZone);
  const occurrences: EventOccurrence[] = [];
  let localStart = first;
  let occurrenceIndex = 0;

  while (rule.count === undefined || occurrenceIndex < rule.count) {
    if (untilDate && Temporal.PlainDate.compare(localStart.toPlainDate(), untilDate) > 0) {
      break;
    }
    if (occurrenceIndex >= MAX_RECURRENCES) {
      throw new RangeError('The recurrence exceeds the maximum of 52 occurrences.');
    }

    const date = localStart.toPlainDate().toString();
    if (!excludedDates.has(date)) {
      const occurrenceStart = new Date(Number(localStart.epochMilliseconds));
      occurrences.push({
        occurrenceIndex,
        startAt: occurrenceStart,
        endAt: new Date(occurrenceStart.getTime() + durationMs),
      });
    }

    occurrenceIndex += 1;
    if (rule.count !== undefined && occurrenceIndex >= rule.count) {
      break;
    }
    const nextStart = addRecurrenceInterval(localStart, rule.frequency, rule.interval);
    if (untilDate && Temporal.PlainDate.compare(nextStart.toPlainDate(), untilDate) > 0) {
      break;
    }
    if (occurrenceIndex >= MAX_RECURRENCES) {
      throw new RangeError('The recurrence exceeds the maximum of 52 occurrences.');
    }
    localStart = nextStart;
  }

  if (occurrences.length === 0) {
    throw new RangeError('The recurrence must include at least one occurrence.');
  }
  return occurrences;
}

function addRecurrenceInterval(
  start: Temporal.ZonedDateTime,
  frequency: RecurrenceFrequency,
  interval: number,
): Temporal.ZonedDateTime {
  switch (frequency) {
    case 'DAILY':
      return start.add({ days: interval });
    case 'WEEKLY':
      return start.add({ weeks: interval });
    case 'MONTHLY':
      return start.add({ months: interval });
  }
}

function parseClockTime(value: string): number | null {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const result = hours * 60 + minutes;
  return result < MINUTES_PER_DAY ? result : null;
}
