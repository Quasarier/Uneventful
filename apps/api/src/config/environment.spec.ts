import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3001',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/uneventful',
  REDIS_URL: 'redis://:password@localhost:6379',
  OBJECT_STORAGE_BUCKET: 'uneventful-test-assets',
  OBJECT_STORAGE_REGION: 'us-east-1',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
  UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
  WEB_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: 'a-test-session-secret-with-at-least-32-characters',
  JWT_PRIVATE_KEY_B64: Buffer.from('test-private-key').toString('base64'),
  JWT_PUBLIC_KEY_B64: Buffer.from('test-public-key').toString('base64'),
  JWT_KEY_ID: 'test-key',
  JWT_ISSUER: 'https://api.uneventful.test',
  JWT_AUDIENCE: 'uneventful-api',
  REFRESH_TOKEN_TTL_DAYS: '30',
};

describe('validateEnvironment', () => {
  it('parses valid configuration and coerces the port', () => {
    expect(validateEnvironment(validEnvironment).PORT).toBe(3001);
    expect(validateEnvironment(validEnvironment).RSVP_RATE_LIMIT_PER_MINUTE).toBe(10);
  });

  it('fails when required keys are missing', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('reports invalid keys without exposing their values', () => {
    let message: string | undefined;

    try {
      validateEnvironment({
        ...validEnvironment,
        UNIVERSITY_EMAIL_DOMAIN: 'invalid domain',
        SESSION_SECRET: 'sensitive-test-value',
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      message = error.message;
    }

    expect(message).toContain('UNIVERSITY_EMAIL_DOMAIN');
    expect(message).toContain('SESSION_SECRET');
    expect(message).not.toContain('sensitive-test-value');
  });

  it('requires HTTPS callback and web origins in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
      }),
    ).toThrow(/GOOGLE_CALLBACK_URL, WEB_ORIGIN/);
  });

  it('requires WEB_ORIGIN to be an origin rather than a path', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        WEB_ORIGIN: 'http://localhost:3000/callback',
      }),
    ).toThrow(/WEB_ORIGIN/);
  });

  it('requires valid object storage configuration', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        OBJECT_STORAGE_BUCKET: 'Invalid Bucket',
      }),
    ).toThrow(/OBJECT_STORAGE_BUCKET/);
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        OBJECT_STORAGE_ENDPOINT: 'http://user:password@localhost:9000',
      }),
    ).toThrow(/OBJECT_STORAGE_ENDPOINT/);
  });

  it('accepts only the configured Google callback endpoint without redirects', () => {
    for (const callbackUrl of [
      'http://localhost:3001/api/v1/auth/other',
      'http://localhost:3001/api/v1/auth/google/callback?next=https://attacker.invalid',
      'http://user@localhost:3001/api/v1/auth/google/callback',
      'javascript://localhost/api/v1/auth/google/callback',
      'http://attacker.invalid/api/v1/auth/google/callback',
    ]) {
      expect(() =>
        validateEnvironment({
          ...validEnvironment,
          GOOGLE_CALLBACK_URL: callbackUrl,
        }),
      ).toThrow(/GOOGLE_CALLBACK_URL/);
    }
  });

  it('defaults trusted proxy hops to zero', () => {
    expect(validateEnvironment(validEnvironment).TRUST_PROXY_HOPS).toBe(0);
  });

  it('defaults the anonymous IP limit above the authenticated-user limit', () => {
    expect(validateEnvironment(validEnvironment).ANONYMOUS_RATE_LIMIT_PER_MINUTE).toBe(1200);
    expect(
      validateEnvironment({
        ...validEnvironment,
        ANONYMOUS_RATE_LIMIT_PER_MINUTE: '301',
      }).ANONYMOUS_RATE_LIMIT_PER_MINUTE,
    ).toBe(301);
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        ANONYMOUS_RATE_LIMIT_PER_MINUTE: '300',
      }),
    ).toThrow(/ANONYMOUS_RATE_LIMIT_PER_MINUTE/);
  });

  it('validates the RSVP rate limit and Redis URL protocol', () => {
    expect(
      validateEnvironment({ ...validEnvironment, RSVP_RATE_LIMIT_PER_MINUTE: '24' })
        .RSVP_RATE_LIMIT_PER_MINUTE,
    ).toBe(24);
    expect(() =>
      validateEnvironment({ ...validEnvironment, RSVP_RATE_LIMIT_PER_MINUTE: '121' }),
    ).toThrow(/RSVP_RATE_LIMIT_PER_MINUTE/);
    expect(() =>
      validateEnvironment({ ...validEnvironment, REDIS_URL: 'https://localhost' }),
    ).toThrow(/REDIS_URL/);
  });

  it('defaults OAuth IP limits to campus-NAT-friendly values and accepts overrides', () => {
    const defaults = validateEnvironment(validEnvironment);
    expect(defaults.GOOGLE_OAUTH_START_RATE_LIMIT_PER_15_MINUTES).toBe(1200);
    expect(defaults.GOOGLE_OAUTH_CALLBACK_RATE_LIMIT_PER_15_MINUTES).toBe(1200);
    expect(
      validateEnvironment({
        ...validEnvironment,
        GOOGLE_OAUTH_START_RATE_LIMIT_PER_15_MINUTES: '1800',
        GOOGLE_OAUTH_CALLBACK_RATE_LIMIT_PER_15_MINUTES: '2400',
      }),
    ).toMatchObject({
      GOOGLE_OAUTH_START_RATE_LIMIT_PER_15_MINUTES: 1800,
      GOOGLE_OAUTH_CALLBACK_RATE_LIMIT_PER_15_MINUTES: 2400,
    });
  });

  it('requires the previous JWT key ID and public key to be configured together', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        JWT_PREVIOUS_KEY_ID: 'previous-key',
      }),
    ).toThrow(/JWT_PREVIOUS_KEY_ID/);
  });

  it('rejects duplicate current and previous JWT key IDs', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        JWT_PREVIOUS_KEY_ID: 'test-key',
        JWT_PREVIOUS_PUBLIC_KEY_B64: Buffer.from('previous-public-key').toString('base64'),
      }),
    ).toThrow(/JWT_PREVIOUS_KEY_ID/);
  });
});
