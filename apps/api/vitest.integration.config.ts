import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
