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
  CAMPUS_TIME_ZONE: 'America/New_York',
  WEB_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: 'a-test-session-secret-with-at-least-32-characters',
  JWT_PRIVATE_KEY_B64: Buffer.from('test-private-key').toString('base64'),
  JWT_PUBLIC_KEY_B64: Buffer.from('test-public-key').toString('base64'),
  JWT_KEY_ID: 'test-key',
  TICKET_SIGNING_PRIVATE_KEY_B64: Buffer.from('test-ticket-private-key').toString('base64'),
  TICKET_SIGNING_PUBLIC_KEY_B64: Buffer.from('test-ticket-public-key').toString('base64'),
  TICKET_SIGNING_KEY_ID: 'test-ticket-key',
  JWT_ISSUER: 'https://api.uneventful.test',
  JWT_AUDIENCE: 'uneventful-api',
  REFRESH_TOKEN_TTL_DAYS: '30',
};

describe('validateEnvironment', () => {
  it('parses valid configuration and coerces the port', () => {
    expect(validateEnvironment(validEnvironment).PORT).toBe(3001);
    expect(validateEnvironment(validEnvironment).RSVP_RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(validateEnvironment(validEnvironment).CHECKIN_RATE_LIMIT_PER_MINUTE).toBe(120);
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

  it('refuses production without a real email provider, unsubscribe key, and VAPID keys', () => {
    let message: string | undefined;
    try {
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        GOOGLE_CALLBACK_URL: 'https://api.example.edu/api/v1/auth/google/callback',
        WEB_ORIGIN: 'https://campus.example.edu',
        JWT_ISSUER: 'https://api.example.edu',
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }

    expect(message).toContain('NOTIFICATION_EMAIL_PROVIDER');
    expect(message).toContain('NOTIFICATION_UNSUBSCRIBE_SECRET');
    expect(message).toContain('WEB_PUSH_VAPID_PUBLIC_KEY');
    expect(message).not.toContain('test-session-secret');
  });

  it('requires Resend credentials when the real email adapter is selected', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NOTIFICATION_EMAIL_PROVIDER: 'resend',
      }),
    ).toThrow(/NOTIFICATION_EMAIL_API_KEY/);
    expect(
      validateEnvironment({
        ...validEnvironment,
        NOTIFICATION_EMAIL_PROVIDER: 'resend',
        NOTIFICATION_EMAIL_API_KEY: 'test-provider-key',
        NOTIFICATION_EMAIL_FROM_ADDRESS: 'notifications@example.edu',
      }).NOTIFICATION_EMAIL_PROVIDER,
    ).toBe('resend');
  });

  it('requires WEB_ORIGIN to be an origin rather than a path', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        WEB_ORIGIN: 'http://localhost:3000/callback',
      }),
    ).toThrow(/WEB_ORIGIN/);
  });

  it('requires a valid IANA campus time zone', () => {
    expect(validateEnvironment(validEnvironment).CAMPUS_TIME_ZONE).toBe('America/New_York');
    expect(() =>
      validateEnvironment({ ...validEnvironment, CAMPUS_TIME_ZONE: 'Not/A_Timezone' }),
    ).toThrow(/CAMPUS_TIME_ZONE/);
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

  it('requires previous ticket key metadata as a distinct pair', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        TICKET_SIGNING_PREVIOUS_KEY_ID: 'previous-ticket-key',
      }),
    ).toThrow(/TICKET_SIGNING_PREVIOUS_KEY_ID/);
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        TICKET_SIGNING_PREVIOUS_KEY_ID: 'test-ticket-key',
        TICKET_SIGNING_PREVIOUS_PUBLIC_KEY_B64:
          Buffer.from('previous-public-key').toString('base64'),
      }),
    ).toThrow(/TICKET_SIGNING_PREVIOUS_KEY_ID/);
  });
});
