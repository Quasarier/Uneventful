import 'reflect-metadata';
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { randomBytes } from 'node:crypto';

const apiPrefix = '/api/v1';
const requestVerbs = new Map<number, string>([
  [RequestMethod.GET, 'GET'],
  [RequestMethod.POST, 'POST'],
  [RequestMethod.PUT, 'PUT'],
  [RequestMethod.PATCH, 'PATCH'],
  [RequestMethod.DELETE, 'DELETE'],
  [RequestMethod.OPTIONS, 'OPTIONS'],
  [RequestMethod.HEAD, 'HEAD'],
  [RequestMethod.ALL, 'ALL'],
]);

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '3001',
  DATABASE_URL: 'postgresql://route:route@localhost:5432/route_inventory',
  REDIS_URL: 'redis://localhost:6379',
  ANONYMOUS_RATE_LIMIT_PER_MINUTE: '1200',
  OBJECT_STORAGE_BUCKET: 'route-inventory-assets',
  OBJECT_STORAGE_REGION: 'us-east-1',
  GOOGLE_CLIENT_ID: randomBytes(16).toString('hex'),
  GOOGLE_CLIENT_SECRET: randomBytes(32).toString('base64'),
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
  UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
  WEB_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: randomBytes(32).toString('base64'),
  JWT_PRIVATE_KEY_B64: randomBytes(32).toString('base64'),
  JWT_PUBLIC_KEY_B64: randomBytes(32).toString('base64'),
  JWT_KEY_ID: 'route-inventory-key',
  JWT_ISSUER: 'https://api.uneventful.test',
  JWT_AUDIENCE: 'uneventful-api',
  REFRESH_TOKEN_TTL_DAYS: '30',
});

function paths(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(paths);
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [''];
}

function joinPath(...segments: string[]): string {
  const joined = `/${segments.filter(Boolean).join('/')}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function isDynamicModule(value: unknown): value is { module: Type<unknown> } {
  return typeof value === 'object' && value !== null && 'module' in value;
}

function collectControllers(root: Type<unknown>): Set<Type<unknown>> {
  const visited = new Set<Type<unknown>>();
  const controllers = new Set<Type<unknown>>();

  function visit(moduleType: Type<unknown>): void {
    if (visited.has(moduleType)) {
      return;
    }
    visited.add(moduleType);

    const moduleControllers =
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleType) as
        Type<unknown>[] | undefined) ?? [];
    for (const controller of moduleControllers) {
      controllers.add(controller);
    }

    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleType) as unknown[] | undefined) ?? [];
    for (const imported of imports) {
      if (typeof imported === 'function') {
        visit(imported as Type<unknown>);
      } else if (isDynamicModule(imported)) {
        visit(imported.module);
      }
    }
  }

  visit(root);
  return controllers;
}

function collectRoutes(root: Type<unknown>): string[] {
  const routes: string[] = [];
  for (const controller of collectControllers(root)) {
    const controllerPaths = paths(Reflect.getMetadata(PATH_METADATA, controller));
    const prototype = controller.prototype as object;
    for (const methodName of Object.getOwnPropertyNames(prototype)) {
      if (methodName === 'constructor') {
        continue;
      }
      const handler = Object.getOwnPropertyDescriptor(prototype, methodName)?.value;
      if (typeof handler !== 'function') {
        continue;
      }
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | number;
      if (requestMethod === undefined) {
        continue;
      }
      const methodPath = paths(Reflect.getMetadata(PATH_METADATA, handler));
      const verb = requestVerbs.get(requestMethod) ?? 'ALL';
      for (const controllerPath of controllerPaths) {
        for (const endpointPath of methodPath) {
          routes.push(`${verb} ${joinPath(apiPrefix, controllerPath, endpointPath)}`);
        }
      }
    }
  }
  return [...new Set(routes)].sort((left, right) => left.localeCompare(right));
}

async function main(): Promise<void> {
  const { AppModule } = await import('../src/app.module');
  for (const route of collectRoutes(AppModule)) {
    process.stdout.write(`${route}\n`);
  }
}

void main();
