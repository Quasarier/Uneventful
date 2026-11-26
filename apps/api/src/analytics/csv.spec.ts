import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, safeCsvFilename } from './csv';

describe('analytics CSV safety', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('neutralizes cells beginning with %j', (prefix) => {
    expect(csvCell(`${prefix}1+1`)).toBe(`"'${prefix.replace(/\r/g, ' ')}1+1"`);
  });

  it('quotes RFC 4180 separators and escapes quotes while removing embedded line breaks', () => {
    expect(csvRow(['Last, First', 'said "hello"\r\n=1'])).toBe(
      '"Last, First","said ""hello"" =1"\r\n',
    );
  });

  it('produces a bounded filename without path or header characters', () => {
    expect(safeCsvFilename('../../Campus: Events\r\n')).toBe('event-Campus-Events.csv');
    expect(safeCsvFilename('💥')).toBe('event-attendees.csv');
  });
});
