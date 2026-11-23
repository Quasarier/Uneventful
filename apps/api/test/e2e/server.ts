import 'reflect-metadata';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import webPush from 'web-push';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Environment } from '../../src/config/environment';
import { HttpExceptionFilter } from '../../src/http-exception.filter';
import { configureRequestBodyLimits } from '../../src/request-body-limits';
import { RealtimeIoAdapter } from '../../src/realtime/realtime-io.adapter';
import { createCorsOptions, helmetOptions } from '../../src/http-security';
import { assertE2eTestEnvironment } from './test-only-environment';
import { installDecoratorMetadataForTsx } from './install-decorator-metadata';

function setEphemeralTestCredentials(): void {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ticketKeyPair = generateKeyPairSync('ed25519');
  const vapidKeys = webPush.generateVAPIDKeys();
  process.env.JWT_PRIVATE_KEY_B64 = Buffer.from(
    keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ).toString('base64');
  process.env.JWT_PUBLIC_KEY_B64 = Buffer.from(
    keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
  ).toString('base64');
  process.env.JWT_KEY_ID = `e2e-${randomBytes(12).toString('hex')}`;
  process.env.TICKET_SIGNING_PRIVATE_KEY_B64 = Buffer.from(
    ticketKeyPair.privateKey.export({ type: 'pkcs8', format: 'der' }),
  ).toString('base64');
  process.env.TICKET_SIGNING_PUBLIC_KEY_B64 = Buffer.from(
    ticketKeyPair.publicKey.export({ type: 'spki', format: 'der' }),
  ).toString('base64');
  process.env.TICKET_SIGNING_KEY_ID = `e2e-ticket-${randomBytes(12).toString('hex')}`;
  process.env.JWT_ISSUER = 'https://api.uneventful.test';
  process.env.JWT_AUDIENCE = 'uneventful-api';
  process.env.SESSION_SECRET = randomBytes(32).toString('base64url');
  process.env.NOTIFICATION_EMAIL_PROVIDER = 'test';
  process.env.NOTIFICATION_UNSUBSCRIBE_SECRET = randomBytes(32).toString('base64url');
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = vapidKeys.publicKey;
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  process.env.WEB_PUSH_VAPID_SUBJECT = 'mailto:security@example.edu';
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

async function createTestBucket(): Promise<void> {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error('E2E object storage endpoint and credentials are required.');
  }

  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: 'uneventful-e2e-assets' }));
  } finally {
    client.destroy();
  }
}

async function bootstrap(): Promise<void> {
  assertE2eTestEnvironment(process.env);
  setEphemeralTestCredentials();
  await createTestBucket();
  await installDecoratorMetadataForTsx();
  const { E2eTestSupportModule } = await import('./test-support.module');

  const app = await NestFactory.create<NestExpressApplication>(E2eTestSupportModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Environment, true>);
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, config.get('WEB_ORIGIN', { infer: true })));
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
