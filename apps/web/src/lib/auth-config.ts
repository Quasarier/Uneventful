const configuredWebOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN;
const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

if (!configuredWebOrigin || !configuredApiBaseUrl) {
  throw new Error('NEXT_PUBLIC_WEB_ORIGIN and NEXT_PUBLIC_API_BASE_URL are required.');
}

if (new URL(configuredWebOrigin).origin !== configuredWebOrigin) {
  throw new Error('NEXT_PUBLIC_WEB_ORIGIN must be an origin without a path.');
}

export const WEB_ORIGIN = configuredWebOrigin;
export const API_BASE_URL = configuredApiBaseUrl.replace(/\/+$/, '');
