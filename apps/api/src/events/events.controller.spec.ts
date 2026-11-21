import { describe, expect, it, vi } from 'vitest';
import {
  AuthRateLimitExceededException,
  type AuthRateLimitService,
} from '../auth/auth-rate-limit.service';
import type { AuthenticatedRequest } from '../auth/auth.types';
import type { Response } from 'express';
import { EventsController } from './events.controller';
import type { EventsService } from './events.service';

const eventId = 'c5a59258-67d1-457a-a93f-e7993f31befa';
const principal = {
  id: '93b1a3e8-0dfd-4c8c-a0a5-1f1790730011',
  role: 'STUDENT' as const,
  tokenVersion: 0,
};

function makeRequest(): AuthenticatedRequest {
  return {
    user: principal,
    ip: '192.0.2.12',
    socket: { remoteAddress: '192.0.2.12' },
  } as AuthenticatedRequest;
}

function makeResponse(): Response {
  const response = {
    status: vi.fn(),
    set: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.set.mockReturnValue(response);
  response.send.mockReturnValue(response);
  return response as unknown as Response;
}

describe('EventsController image delivery rate limit', () => {
  it('limits by client IP and authenticated user before streaming the image', async () => {
    const events = {
      getImage: vi.fn().mockResolvedValue({
        body: Buffer.from('image'),
        contentType: 'image/png',
        extension: 'png',
      }),
    };
    const rateLimit = { consume: vi.fn().mockResolvedValue(undefined) };
    const controller = new EventsController(
      events as unknown as EventsService,
      rateLimit as unknown as AuthRateLimitService,
    );

    const response = makeResponse();
    await controller.getImage(makeRequest(), eventId, response);

    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      1,
      'event-image-ip',
      '192.0.2.12',
      120,
      60_000,
      expect.objectContaining({ exceeded: 'Too many image requests. Try again later.' }),
    );
    expect(rateLimit.consume).toHaveBeenNthCalledWith(
      2,
      'event-image-user',
      principal.id,
      120,
      60_000,
      expect.objectContaining({ exceeded: 'Too many image requests. Try again later.' }),
    );
    expect(events.getImage).toHaveBeenCalledWith(principal, eventId);
    expect(response.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Cross-Origin-Resource-Policy': 'cross-origin' }),
    );
  });

  it('does not access image storage after a rate limit is exceeded', async () => {
    const events = { getImage: vi.fn() };
    const rateLimit = {
      consume: vi
        .fn()
        .mockRejectedValue(
          new AuthRateLimitExceededException('Too many image requests. Try again later.'),
        ),
    };
    const controller = new EventsController(
      events as unknown as EventsService,
      rateLimit as unknown as AuthRateLimitService,
    );

    await expect(controller.getImage(makeRequest(), eventId, makeResponse())).rejects.toThrow(
      'Too many image requests. Try again later.',
    );
    expect(events.getImage).not.toHaveBeenCalled();
  });
});
