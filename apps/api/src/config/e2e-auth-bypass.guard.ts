export function assertE2eAuthBypassNotEnabledInProduction(environment: NodeJS.ProcessEnv): void {
  if (environment.NODE_ENV === 'production' && environment.E2E_TEST_AUTH_BYPASS !== undefined) {
    throw new Error('E2E_TEST_AUTH_BYPASS is forbidden in production.');
  }
}
