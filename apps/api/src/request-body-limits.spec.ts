import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter';
import {
  configureRequestBodyLimits,
  MAX_API_REQUEST_BODY_BYTES,
  MAX_URL_ENCODED_PARAMETERS,
} from './request-body-limits';

@Controller('body-limit-test')
class BodyLimitTestController {
  @Post()
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Module({ controllers: [BodyLimitTestController] })
class BodyLimitTestModule {}

describe('request body limits', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('rejects JSON bodies larger than the explicit API limit with a normalized 413', async () => {
    const port = await startBodyLimitServer();
    const response = await fetch(`http://127.0.0.1:${port}/body-limit-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(MAX_API_REQUEST_BODY_BYTES) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large.',
    });
  });

  it('rejects oversized JSON sent with chunked transfer encoding', async () => {
    const response = await sendOversizedJson(await startBodyLimitServer(), true);

    expect(response.transferEncoding).toBe('chunked');
    expect(response.contentLength).toBeUndefined();
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large.',
    });
  });

  it('rejects oversized streamed JSON when Content-Length is absent', async () => {
    const response = await sendOversizedJson(await startBodyLimitServer(), false);

    expect(response.contentLength).toBeUndefined();
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large.',
    });
  });

  it('rejects excessive URL-encoded parameter counts with a normalized 413', async () => {
    const port = await startBodyLimitServer();
    const body = Array.from(
      { length: MAX_URL_ENCODED_PARAMETERS + 1 },
      (_, index) => `field${index}=x`,
    ).join('&');
    const response = await fetch(`http://127.0.0.1:${port}/body-limit-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Too many request body parameters.',
    });
  });

  async function startBodyLimitServer(): Promise<number> {
    app = await NestFactory.create<NestExpressApplication>(BodyLimitTestModule, {
      bodyParser: false,
      logger: false,
    });
    configureRequestBodyLimits(app);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine request-body test server address.');
    }
    return address.port;
  }
});

function sendOversizedJson(
  port: number,
  explicitChunkedEncoding: boolean,
): Promise<{
  statusCode: number;
  body: string;
  contentLength: string | number | string[] | undefined;
  transferEncoding: string | number | string[] | undefined;
}> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (explicitChunkedEncoding) {
      headers['Transfer-Encoding'] = 'chunked';
    }
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/body-limit-test', method: 'POST', headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
            contentLength: request.getHeader('content-length'),
            transferEncoding: request.getHeader('transfer-encoding'),
          });
        });
      },
    );
    request.on('error', reject);
    request.write('{"value":"');
    for (let remaining = MAX_API_REQUEST_BODY_BYTES + 1024; remaining > 0; remaining -= 8192) {
      request.write('x'.repeat(Math.min(8192, remaining)));
    }
    request.end('"}');
  });
}
