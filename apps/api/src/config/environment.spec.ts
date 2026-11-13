import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3001',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/campuspulse',
  REDIS_URL: 'redis://:password@localhost:6379',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
  UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
  WEB_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: 'a-test-session-secret-with-at-least-32-characters',
};

describe('validateEnvironment', () => {
  it('parses valid configuration and coerces the port', () => {
    expect(validateEnvironment(validEnvironment).PORT).toBe(3001);
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
});
