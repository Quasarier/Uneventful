import { describe, expect, it } from 'vitest';
import { assertE2eTestEnvironment } from './test-only-environment';

describe('E2E test-only environment guard', () => {
  it('refuses to start in production when the bypass flag is set', () => {
    expect(() =>
      assertE2eTestEnvironment({
        NODE_ENV: 'production',
        E2E_TEST_AUTH_BYPASS: '1',
        E2E_TEST_AUTH_BYPASS_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow('cannot be enabled outside NODE_ENV=test');
  });

  it('requires the explicit test flag and a strong test-only secret', () => {
    expect(() =>
      assertE2eTestEnvironment({
        NODE_ENV: 'test',
        E2E_TEST_AUTH_BYPASS_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow('E2E_TEST_AUTH_BYPASS=1 is required');
    expect(() =>
      assertE2eTestEnvironment({
        NODE_ENV: 'test',
        E2E_TEST_AUTH_BYPASS: '1',
        E2E_TEST_AUTH_BYPASS_SECRET: 'a'.repeat(32),
      }),
    ).toThrow('DATABASE_URL and REDIS_URL');
  });

  it('accepts test mode only when the secret and database services are present', () => {
    expect(() =>
      assertE2eTestEnvironment({
        NODE_ENV: 'test',
        E2E_TEST_AUTH_BYPASS: '1',
        E2E_TEST_AUTH_BYPASS_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).not.toThrow();
  });
});
