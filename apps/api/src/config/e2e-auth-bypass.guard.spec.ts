import { describe, expect, it } from 'vitest';
import { assertE2eAuthBypassNotEnabledInProduction } from './e2e-auth-bypass.guard';

describe('production E2E auth-bypass guard', () => {
  it('refuses production API startup when the test bypass flag is set', () => {
    expect(() =>
      assertE2eAuthBypassNotEnabledInProduction({
        NODE_ENV: 'production',
        E2E_TEST_AUTH_BYPASS: '1',
      }),
    ).toThrow('E2E_TEST_AUTH_BYPASS is forbidden in production.');
  });

  it('allows normal production startup when the test bypass flag is absent', () => {
    expect(() =>
      assertE2eAuthBypassNotEnabledInProduction({
        NODE_ENV: 'production',
      }),
    ).not.toThrow();
  });
});
