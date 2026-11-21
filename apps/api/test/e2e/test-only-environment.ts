export function assertE2eTestEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.E2E_TEST_AUTH_BYPASS !== undefined && environment.NODE_ENV !== 'test') {
    throw new Error('E2E_TEST_AUTH_BYPASS cannot be enabled outside NODE_ENV=test.');
  }
  if (environment.NODE_ENV !== 'test') {
    throw new Error('The E2E API server is available only when NODE_ENV=test.');
  }
  if (environment.E2E_TEST_AUTH_BYPASS !== '1') {
    throw new Error('E2E_TEST_AUTH_BYPASS=1 is required to start the E2E API server.');
  }
  if (
    !environment.E2E_TEST_AUTH_BYPASS_SECRET ||
    environment.E2E_TEST_AUTH_BYPASS_SECRET.length < 32
  ) {
    throw new Error('A test-only E2E auth secret of at least 32 characters is required.');
  }
  if (!environment.DATABASE_URL || !environment.REDIS_URL) {
    throw new Error('DATABASE_URL and REDIS_URL are required for the E2E API server.');
  }
}
