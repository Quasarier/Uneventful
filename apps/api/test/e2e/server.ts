import 'reflect-metadata';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Environment } from '../../src/config/environment';
import { HttpExceptionFilter } from '../../src/http-exception.filter';
import { configureRequestBodyLimits } from '../../src/request-body-limits';
import { createCorsOptions, helmetOptions } from '../../src/http-security';
import { assertE2eTestEnvironment } from './test-only-environment';
import { installDecoratorMetadataForTsx } from './install-decorator-metadata';

function setEphemeralTestCredentials(): void {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY_B64 = Buffer.from(
    keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ).toString('base64');
  process.env.JWT_PUBLIC_KEY_B64 = Buffer.from(
    keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
  ).toString('base64');
  process.env.JWT_KEY_ID = `e2e-${randomBytes(12).toString('hex')}`;
  process.env.JWT_ISSUER = 'https://api.uneventful.test';
  process.env.JWT_AUDIENCE = 'uneventful-api';
  process.env.SESSION_SECRET = randomBytes(32).toString('base64url');
  process.env.GOOGLE_CLIENT_ID = `e2e-${randomBytes(16).toString('hex')}`;
  process.env.GOOGLE_CLIENT_SECRET = randomBytes(32).toString('base64url');
  process.env.GOOGLE_CALLBACK_URL = `http://localhost:${process.env.PORT ?? '3001'}/api/v1/auth/google/callback`;
  process.env.UNIVERSITY_EMAIL_DOMAIN = 'example.edu';
  process.env.OBJECT_STORAGE_BUCKET = 'uneventful-e2e-assets';
  process.env.OBJECT_STORAGE_REGION = 'us-east-1';
  process.env.REFRESH_TOKEN_TTL_DAYS = '1';
  process.env.WEB_ORIGIN ??= 'http://localhost:3000';
  process.env.PORT ??= '3001';
}

async function bootstrap(): Promise<void> {
  assertE2eTestEnvironment(process.env);
  setEphemeralTestCredentials();
  await installDecoratorMetadataForTsx();
  const { E2eTestSupportModule } = await import('./test-support.module');

  const app = await NestFactory.create<NestExpressApplication>(E2eTestSupportModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Environment, true>);
  app.getHttpAdapter().getInstance().set('trust proxy', 0);
  configureRequestBodyLimits(app);
  app.setGlobalPrefix('api/v1');
  app.use(helmet(helmetOptions));
  app.enableCors(createCorsOptions(config.get('WEB_ORIGIN', { infer: true })));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}

void bootstrap();
