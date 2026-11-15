export const MAX_EVENT_IMAGE_SIZE = 5 * 1024 * 1024;
export const EVENT_IMAGE_UPLOAD_TTL_SECONDS = 300;

export const ALLOWED_EVENT_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type EventImageContentType = keyof typeof ALLOWED_EVENT_IMAGE_TYPES;

export function isEventImageContentType(value: string): value is EventImageContentType {
  return Object.hasOwn(ALLOWED_EVENT_IMAGE_TYPES, value);
}
