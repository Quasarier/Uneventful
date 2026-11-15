import createClient from 'openapi-fetch';
import { API_BASE_URL } from '@/lib/auth-config';
import type { paths } from '@/lib/api-schema';

export function createApiClient(accessToken?: string) {
  return createClient<paths>({
    baseUrl: API_BASE_URL,
    credentials: 'include',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  });
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function errorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null || !('message' in value)) {
    return fallback;
  }
  const message = value.message;
  if (typeof message === 'string' && message.trim()) {
    return message;
  }
  if (Array.isArray(message)) {
    const messages = message.filter((entry): entry is string => typeof entry === 'string');
    if (messages.length > 0) {
      return messages.join(' ');
    }
  }
  return fallback;
}
