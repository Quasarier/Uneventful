import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Environment } from './config/environment';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './http-exception.filter';
import { createCorsOptions, helmetOptions } from './http-security';
import { configureRequestBodyLimits } from './request-body-limits';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Environment, true>);

  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));
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
