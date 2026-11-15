import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

export const descriptionSanitizerOptions: sanitizeHtml.IOptions = {
  allowedTags: ['a', 'blockquote', 'br', 'em', 'li', 'ol', 'p', 'strong', 'ul'],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
};

export function sanitizeDescription(description: string): string {
  const sanitized = sanitizeHtml(description, descriptionSanitizerOptions).trim();
  if (!sanitized) {
    throw new BadRequestException('Description must contain readable text.');
  }
  return sanitized;
}
