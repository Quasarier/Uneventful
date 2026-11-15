import type { NestExpressApplication } from '@nestjs/platform-express';

export const MAX_API_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_URL_ENCODED_PARAMETERS = 100;

export function configureRequestBodyLimits(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: MAX_API_REQUEST_BODY_BYTES });
  app.useBodyParser('urlencoded', {
    limit: MAX_API_REQUEST_BODY_BYTES,
    extended: false,
    parameterLimit: MAX_URL_ENCODED_PARAMETERS,
  });
}
