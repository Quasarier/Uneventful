import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpExceptionFilter } from '../../src/http-exception.filter';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ? value
    : undefined;
}

function getStatus(exception: unknown): number {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  const bodyParserError = isRecord(exception) ? exception.type : undefined;
  if (bodyParserError === 'entity.too.large' || bodyParserError === 'parameters.too.many') {
    return HttpStatus.PAYLOAD_TOO_LARGE;
  }
  if (bodyParserError === 'entity.parse.failed') {
    return HttpStatus.BAD_REQUEST;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function safeErrorDetails(exception: unknown): Record<string, string> {
  const details: Record<string, string> = {
    errorType:
      exception instanceof Error ? (safeIdentifier(exception.name) ?? 'Error') : 'UnknownError',
  };
  if (!isRecord(exception)) {
    return details;
  }

  if (
    typeof exception.code === 'string' &&
    (/^P\d{4}$/.test(exception.code) || /^[0-9A-Z]{5}$/.test(exception.code))
  ) {
    details.errorCode = exception.code;
  }
  if (!isRecord(exception.meta)) {
    return details;
  }

  const model = safeIdentifier(exception.meta.modelName);
  const table = safeIdentifier(exception.meta.table);
  const column = safeIdentifier(exception.meta.column);
  const field = safeIdentifier(exception.meta.field_name);
  if (model) {
    details.model = model;
  }
  if (table) {
    details.table = table;
  }
  if (column) {
    details.column = column;
  }
  if (field) {
    details.field = field;
  }
  return details;
}

@Catch()
export class E2eHttpExceptionFilter implements ExceptionFilter {
  private readonly responseFilter = new HttpExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    const status = getStatus(exception);
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const correlationId = randomUUID();
      const response = host.switchToHttp().getResponse<Response>();
      response.setHeader('X-Correlation-ID', correlationId);
      process.stdout.write(
        `${JSON.stringify({
          event: 'e2e_http_5xx',
          correlationId,
          status,
          ...safeErrorDetails(exception),
        })}\n`,
      );
    }
    this.responseFilter.catch(exception, host);
  }
}
