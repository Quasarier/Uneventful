import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const webOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
const apiOrigin = new URL(apiBaseUrl).origin;
const apiPort = new URL(apiBaseUrl).port || '3001';
const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL ?? process.env.TEST_REDIS_URL;
const e2eSecret = process.env.E2E_TEST_AUTH_BYPASS_SECRET ?? randomBytes(32).toString('base64url');

if (!databaseUrl || !redisUrl) {
  throw new Error('DATABASE_URL and REDIS_URL (or their TEST_ equivalents) are required for E2E.');
}
process.env.E2E_TEST_AUTH_BYPASS_SECRET = e2eSecret;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: webOrigin,
    browserName: 'chromium',
  },
  webServer: [
    {
      command: 'corepack pnpm --filter @uneventful/api test:e2e:server',
      url: `${apiOrigin}/api/v1/health/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: databaseUrl,
        E2E_TEST_AUTH_BYPASS: '1',
        E2E_TEST_AUTH_BYPASS_SECRET: e2eSecret,
        NODE_ENV: 'test',
        PORT: apiPort,
        REDIS_URL: redisUrl,
        WEB_ORIGIN: webOrigin,
      },
    },
    {
      command: 'corepack pnpm --filter @uneventful/web dev',
      url: webOrigin,
      reuseExistingServer: !process.env.CI,
      env: {
        NEXT_PUBLIC_WEB_ORIGIN: webOrigin,
        NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
      },
    },
  ],
});
