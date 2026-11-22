import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthRateLimitExceededException } from './auth/auth-rate-limit.service';
import { VenueConflictException } from './venues/venue-conflict.exception';

function errorCodeFor(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'TOO_MANY_REQUESTS';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'PAYLOAD_TOO_LARGE';
    default:
      return status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_ERROR';
  }
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    if (exception instanceof VenueConflictException) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        code: errorCodeFor(HttpStatus.CONFLICT),
        message: exception.conflict.message,
        reasons: [...exception.conflict.reasons],
        conflicts: exception.conflict.conflicts.map(({ startAt, endAt }) => ({
          startAt,
          endAt,
        })),
        alternatives: exception.conflict.alternatives.map(
          ({ venueId, name, building, startAt, endAt }) => ({
            venueId,
            name,
            building,
            startAt,
            endAt,
          }),
        ),
        path: request.path,
      });
      return;
    }
    const bodyParserError =
      typeof exception === 'object' && exception !== null && 'type' in exception
        ? exception.type
        : undefined;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : bodyParserError === 'entity.too.large' || bodyParserError === 'parameters.too.many'
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : bodyParserError === 'entity.parse.failed'
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : undefined;
    const rawMessage =
      typeof body === 'object' && body !== null && 'message' in body
        ? body.message
        : exception instanceof HttpException
          ? exception.message
          : bodyParserError === 'entity.too.large'
            ? 'Request body too large.'
            : bodyParserError === 'parameters.too.many'
              ? 'Too many request body parameters.'
              : bodyParserError === 'entity.parse.failed'
                ? 'Invalid request body.'
                : 'Internal server error';
    const message = Array.isArray(rawMessage)
      ? rawMessage.join('; ')
      : typeof rawMessage === 'string'
        ? rawMessage
        : 'Internal server error';
    const path =
      status === HttpStatus.NOT_FOUND && request.route
        ? `${request.baseUrl}${request.route.path}`
        : request.path;

    if (exception instanceof AuthRateLimitExceededException) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    response.status(status).json({
      statusCode: status,
      code: errorCodeFor(status),
      message: status >= 500 ? 'Internal server error' : message,
      path,
    });
  }
}
