import type { MyRsvp } from './event-format';

function escapeText(value: string): string {
  const safeText = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
  return Array.from(safeText, (character) => {
    const code = character.charCodeAt(0);
    return (code < 0x20 && code !== 0x09) || code === 0x7f ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function toUtcDate(value: string): string {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of line) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > 75 && chunk) {
      chunks.push(chunk);
      chunk = character;
      bytes = characterBytes + 1;
    } else {
      chunk += character;
      bytes += characterBytes;
    }
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks.join('\r\n ');
}

export function createIcal(rsvps: MyRsvp[], createdAt = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Uneventful//Campus Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const rsvp of rsvps) {
    if (rsvp.status !== 'GOING' && rsvp.status !== 'WAITLISTED') {
      continue;
    }
    const event = rsvp.event;
    const title = rsvp.status === 'WAITLISTED' ? `[Waitlist] ${event.title}` : event.title;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${rsvp.id}@uneventful`,
      `DTSTAMP:${toUtcDate(createdAt.toISOString())}`,
      `DTSTART:${toUtcDate(event.startAt)}`,
      `DTEND:${toUtcDate(event.endAt)}`,
      `SUMMARY:${escapeText(title)}`,
      `DESCRIPTION:${escapeText(event.description)}`,
      `LOCATION:${escapeText(event.club.name)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
