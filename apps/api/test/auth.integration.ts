import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { decodeProtectedHeader, exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { validateEnvironment, type Environment } from '../src/config/environment';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthController } from '../src/auth/auth.controller';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService } from '../src/auth/auth.service';
import { GoogleOidcService } from '../src/auth/google-oidc.service';
import { HttpExceptionFilter } from '../src/http-exception.filter';

let authService: AuthService;
let authConfig: ConfigService<Environment, true>;

Reflect.defineMetadata(
  'design:paramtypes',
  [AuthService, GoogleOidcService, ConfigService, AuthRateLimitService],
  AuthController,
);

@Module({
  controllers: [AuthController],
  providers: [
    { provide: AuthService, useFactory: () => authService },
    { provide: GoogleOidcService, useValue: {} },
    { provide: ConfigService, useFactory: () => authConfig },
    { provide: AuthRateLimitService, useValue: { consume: async () => undefined } },
  ],
})
class AuthHttpIntegrationModule {}

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for API integration tests.');
}

describe('authentication database integration', () => {
  let prisma: PrismaService | undefined;
  let repository: AuthRepository;
  let userId: string | undefined;
  let httpApp: INestApplication | undefined;
  let httpBaseUrl: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    });
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      PORT: 3001,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      GOOGLE_CLIENT_ID: 'integration-test-client',
      GOOGLE_CLIENT_SECRET: 'integration-test-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/v1/auth/google/callback',
      UNIVERSITY_EMAIL_DOMAIN: 'example.edu',
      WEB_ORIGIN: 'http://localhost:3000',
      SESSION_SECRET: randomUUID() + randomUUID(),
      JWT_PRIVATE_KEY_B64: Buffer.from(await exportPKCS8(keyPair.privateKey)).toString('base64'),
      JWT_PUBLIC_KEY_B64: Buffer.from(await exportSPKI(keyPair.publicKey)).toString('base64'),
      JWT_KEY_ID: 'integration-test-key',
      JWT_ISSUER: 'https://api.uneventful.test',
      JWT_AUDIENCE: 'uneventful-api',
      REFRESH_TOKEN_TTL_DAYS: 30,
      OBJECT_STORAGE_BUCKET: 'auth-integration',
      OBJECT_STORAGE_REGION: 'us-east-1',
    });
    authConfig = new ConfigService<Environment, true>(environment);
    prisma = new PrismaService(authConfig);
    await prisma.$connect();
    repository = new AuthRepository(prisma);
    authService = new AuthService(authConfig, repository);
    await authService.onModuleInit();

    httpApp = await NestFactory.create(AuthHttpIntegrationModule, { logger: false });
    httpApp.setGlobalPrefix('api/v1');
    httpApp.useGlobalFilters(new HttpExceptionFilter());
    await httpApp.listen(0, '127.0.0.1');
    const address = httpApp.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine authentication integration server address.');
    }
    httpBaseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  beforeEach(async () => {
    userId = randomUUID();
    const subject = `integration-${userId}`;
    await prisma!.user.create({
      data: {
        id: userId,
        googleSubject: subject,
        email: `${subject}@example.edu`,
        firstName: 'Integration',
        lastName: 'Test',
      },
    });
  });

  afterEach(async () => {
    if (userId) {
      await prisma!.refreshToken.deleteMany({ where: { userId } });
      await prisma!.user.delete({ where: { id: userId } });
    }
  });

  afterAll(async () => {
    await httpApp?.close();
    await prisma?.$disconnect();
  });

  it('rotates a refresh token and revokes its entire family on replay', async () => {
    const first = await createSessionForUser();
    const second = await authService.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const previous = await prisma!.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hash(first.refreshToken) },
    });
    expect(previous.revokedAt).toBeInstanceOf(Date);
    expect(previous.replacedById).not.toBeNull();

    await expect(authService.refresh(first.refreshToken)).rejects.toThrow(
      'Refresh token reuse detected.',
    );
    const family = await prisma!.refreshToken.findMany({
      where: { familyId: previous.familyId },
    });
    expect(family.length).toBe(2);
    expect(family.every((token) => token.revokedAt !== null)).toBe(true);
  });

  it('allows only one of ten parallel HTTP refreshes and revokes the whole token family', async () => {
    const session = await createSessionForUser();
    const original = await prisma!.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hash(session.refreshToken) },
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${httpBaseUrl}/auth/refresh`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            'X-Uneventful-CSRF': '1',
            Cookie: `__Secure-uneventful_refresh=${session.refreshToken}`,
          },
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(9);
    const family = await prisma!.refreshToken.findMany({
      where: { familyId: original.familyId },
    });
    expect(family).toHaveLength(2);
    expect(family.every((token) => token.revokedAt !== null)).toBe(true);
  });

  it('updates the same user on repeat login instead of creating duplicates', async () => {
    const first = await createSessionForUser();
    const second = await createSessionForUser();
    const currentUserId = userId;
    if (!currentUserId) {
      throw new Error('Test user was not created.');
    }

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(decodeProtectedHeader(second.accessToken).kid).toBe('integration-test-key');
    await expect(prisma!.user.count({ where: { id: currentUserId } })).resolves.toBe(1);
    await expect(prisma!.refreshToken.count({ where: { userId: currentUserId } })).resolves.toBe(2);
  });

  it('expires a refresh-token family when its token is expired', async () => {
    const session = await createSessionForUser();
    const token = await prisma!.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hash(session.refreshToken) },
    });
    await prisma!.refreshToken.update({
      where: { id: token.id },
      data: { expiresAt: new Date(Date.now() + 1) },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(authService.refresh(session.refreshToken)).rejects.toThrow(
      'Refresh token has expired.',
    );
    const stored = await prisma!.refreshToken.findUniqueOrThrow({
      where: { id: token.id },
    });
    expect(stored.revokedAt).toBeInstanceOf(Date);
  });

  it('invalidates access and refresh tokens when the role changes', async () => {
    const session = await createSessionForUser();
    await expect(authService.authenticateAccessToken(session.accessToken)).resolves.toMatchObject({
      id: userId,
      role: 'STUDENT',
      tokenVersion: 0,
    });

    await prisma!.user.update({
      where: { id: userId! },
      data: { role: 'ORGANIZER' },
    });
    const user = await prisma!.user.findUniqueOrThrow({ where: { id: userId! } });
    expect(user.tokenVersion).toBe(1);
    const storedToken = await prisma!.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hash(session.refreshToken) },
    });
    expect(storedToken.revokedAt).toBeInstanceOf(Date);

    await expect(authService.authenticateAccessToken(session.accessToken)).rejects.toThrow(
      'Access token is no longer valid.',
    );
    await expect(authService.refresh(session.refreshToken)).rejects.toThrow(
      'Refresh token reuse detected.',
    );
  });

  it('invalidates every device after logout-all', async () => {
    const session = await createSessionForUser();
    await authService.logoutAll(userId!);

    await expect(authService.authenticateAccessToken(session.accessToken)).rejects.toThrow(
      'Access token is no longer valid.',
    );
    await expect(authService.refresh(session.refreshToken)).rejects.toThrow(
      'Refresh token reuse detected.',
    );
  });

  async function createSessionForUser() {
    if (!userId) {
      throw new Error('Test user was not created.');
    }

    return authService.completeGoogleLogin({
      googleSubject: `integration-${userId}`,
      email: `integration-${userId}@example.edu`,
      firstName: 'Integration',
      lastName: 'Test',
      avatarUrl: null,
    });
  }
});

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
