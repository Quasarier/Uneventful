import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest, AuthPrincipal } from '../auth/auth.types';
import { validateEnvironment, type Environment } from '../config/environment';
import { RsvpsController } from './rsvps.controller';
import { RsvpsService } from './rsvps.service';

function config(): ConfigService<Environment, true> {
  return new ConfigService<Environment, true>(
    validateEnvironment({
      NODE_ENV: 'test',
      PORT: 3001,
      DATABASE_URL: 'postgresql://user:password@localhost:5432/uneventful',
      REDIS_URL: 'redis://localhost:6379',
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
      TICKET_SIGNING_PRIVATE_KEY_B64: Buffer.from('test-ticket-private-key').toString('base64'),
      TICKET_SIGNING_PUBLIC_KEY_B64: Buffer.from('test-ticket-public-key').toString('base64'),
      TICKET_SIGNING_KEY_ID: 'test-ticket-key',
      JWT_ISSUER: 'https://api.uneventful.test',
      JWT_AUDIENCE: 'uneventful-api',
      REFRESH_TOKEN_TTL_DAYS: 30,
    }),
  );
}

describe('RsvpsController', () => {
  it('limits each RSVP operation by authenticated user using the configured limit', async () => {
    const principal: AuthPrincipal = {
      id: '4a75d204-15d7-4e31-bd8b-561fb1fd1619',
      role: 'STUDENT',
      tokenVersion: 0,
    };
    const service = {
      getStatus: vi.fn().mockResolvedValue({ status: null, isFull: false }),
      rsvp: vi.fn().mockResolvedValue({ status: 'GOING' }),
      cancel: vi.fn(),
      issueTicket: vi.fn(),
    } as unknown as RsvpsService;
    const rateLimit = { consume: vi.fn().mockResolvedValue(undefined) };
    const controller = new RsvpsController(
      service,
      rateLimit as unknown as AuthRateLimitService,
      config(),
    );

    await controller.rsvp(
      { user: principal } as AuthenticatedRequest,
      '52f8a091-799c-4f90-bd7f-7c48266d45f1',
      { checkConflicts: true },
    );

    expect(rateLimit.consume).toHaveBeenCalledWith(
      'rsvp-user',
      principal.id,
      10,
      60_000,
      expect.objectContaining({
        exceeded: 'Too many RSVP requests. Try again later.',
      }),
    );
    expect(service.rsvp).toHaveBeenCalledWith(
      '52f8a091-799c-4f90-bd7f-7c48266d45f1',
      principal.id,
      true,
    );
  });

  it('returns the authenticated user RSVP status and applies the user rate limit', async () => {
    const principal: AuthPrincipal = {
      id: '4a75d204-15d7-4e31-bd8b-561fb1fd1619',
      role: 'ORGANIZER',
      tokenVersion: 0,
    };
    const service = {
      getStatus: vi.fn().mockResolvedValue({ status: null, isFull: false }),
    } as unknown as RsvpsService;
    const rateLimit = { consume: vi.fn().mockResolvedValue(undefined) };
    const controller = new RsvpsController(
      service,
      rateLimit as unknown as AuthRateLimitService,
      config(),
    );

    await expect(
      controller.getStatus(
        { user: principal } as AuthenticatedRequest,
        '52f8a091-799c-4f90-bd7f-7c48266d45f1',
      ),
    ).resolves.toEqual({ status: null, isFull: false });

    expect(service.getStatus).toHaveBeenCalledWith(
      '52f8a091-799c-4f90-bd7f-7c48266d45f1',
      principal.id,
    );
    expect(rateLimit.consume).toHaveBeenCalledWith(
      'rsvp-user',
      principal.id,
      10,
      60_000,
      expect.any(Object),
    );
  });
});
