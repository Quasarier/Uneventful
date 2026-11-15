import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter';

function createHttpHost(path = '/api/v1/events') {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const request = { path };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  };
  return { host, response };
}

describe('HttpExceptionFilter', () => {
  it('normalizes validation errors into a consistent response shape', () => {
    const filter = new HttpExceptionFilter();
    const { host, response } = createHttpHost();

    filter.catch(
      new BadRequestException(['title is required', 'eventId must be a UUID']),
      host as never,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'title is required; eventId must be a UUID',
      path: '/api/v1/events',
    });
  });

  it('never returns internal exception messages or stack traces', () => {
    const filter = new HttpExceptionFilter();
    const { host, response } = createHttpHost();

    filter.catch(new Error('secret database detail\nat internal.file:42'), host as never);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      path: '/api/v1/events',
    });
  });

  it('normalizes oversized-body parser errors to 413 without exposing parser details', () => {
    const filter = new HttpExceptionFilter();
    const { host, response } = createHttpHost('/api/v1/events');

    filter.catch({ type: 'entity.too.large', message: 'internal parser details' }, host as never);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large.',
      path: '/api/v1/events',
    });
  });

  it('normalizes excessive URL-encoded parameter errors to 413', () => {
    const filter = new HttpExceptionFilter();
    const { host, response } = createHttpHost('/api/v1/auth');

    filter.catch({ type: 'parameters.too.many' }, host as never);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Too many request body parameters.',
      path: '/api/v1/auth',
    });
  });

  it('uses the route template for 404s so hidden and unknown IDs have identical responses', () => {
    const filter = new HttpExceptionFilter();
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const request = {
      path: '/api/v1/events/unknown-or-hidden-id/image',
      baseUrl: '',
      route: { path: '/api/v1/events/:id/image' },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    };

    filter.catch(new NotFoundException('Event not found.'), host as never);

    expect(response.json).toHaveBeenCalledWith({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Event not found.',
      path: '/api/v1/events/:id/image',
    });
  });
});
