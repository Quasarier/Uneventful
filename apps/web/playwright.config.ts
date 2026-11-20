import { defineConfig } from '@playwright/test';

const webOrigin = process.env.NEXT_PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: webOrigin,
    browserName: 'chromium',
  },
  webServer: {
    command: 'corepack pnpm --filter @uneventful/web dev',
    url: webOrigin,
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_PUBLIC_WEB_ORIGIN: webOrigin,
      NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
    },
  },
});
