const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const safeValue = `${FORMULA_PREFIX.test(value) ? "'" : ''}${value.replace(/\r\n|\r|\n/g, ' ')}`;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly string[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

export function safeCsvFilename(slug: string): string {
  const safeSlug = slug
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `event-${safeSlug || 'attendees'}.csv`;
}
