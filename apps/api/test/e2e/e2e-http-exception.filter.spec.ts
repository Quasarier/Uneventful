import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { E2eHttpExceptionFilter } from './e2e-http-exception.filter';

function createHttpHost() {
  const response = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const request = { path: '/api/v1/__test/e2e/fixtures/:fixtureId/session' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  };
  return { host, response };
}

describe('E2eHttpExceptionFilter', () => {
  it('logs safe structured error details with a response correlation id for 5xx errors', () => {
    const filter = new E2eHttpExceptionFilter();
    const { host, response } = createHttpHost();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exception = Object.assign(new Error('alice@example.edu Bearer sensitive-token'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2022',
      meta: {
        modelName: 'RefreshToken',
        table: 'refresh_tokens',
        column: 'google_authenticated_at',
      },
    });

    filter.catch(exception, host as never);

    expect(response.status).toHaveBeenCalledWith(500);
    const [headerName, correlationId] = response.setHeader.mock.calls[0] ?? [];
    expect(headerName).toBe('X-Correlation-ID');
    expect(correlationId).toEqual(expect.any(String));
    const loggedOutput = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(loggedOutput).toContain(correlationId);
    expect(loggedOutput).toContain('"errorCode":"P2022"');
    expect(loggedOutput).toContain('"model":"RefreshToken"');
    expect(loggedOutput).toContain('"column":"google_authenticated_at"');
    expect(loggedOutput).not.toContain('alice@example.edu');
    expect(loggedOutput).not.toContain('sensitive-token');
    output.mockRestore();
  });

  it('does not log client errors', () => {
    const filter = new E2eHttpExceptionFilter();
    const { host, response } = createHttpHost();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    filter.catch(new BadRequestException('invalid input'), host as never);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    output.mockRestore();
  });
});
