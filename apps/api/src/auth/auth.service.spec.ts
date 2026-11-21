import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../config/environment';
import { AuthRepository, type AuthUserState, type RefreshRecord } from './auth.repository';
import { AuthService } from './auth.service';

const ISSUER = 'https://api.uneventful.test';
const AUDIENCE = 'uneventful-api';

describe('AuthService', () => {
  let service: AuthService;
  let repository: AuthRepository;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let previousPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicKeyPem: string;
  let previousPublicKeyPem: string;
  let userId: string;

  beforeEach(async () => {
    const keyPair = await generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    });
    const previousKeyPair = await generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    });
    privateKey = keyPair.privateKey;
    previousPrivateKey = previousKeyPair.privateKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
    previousPublicKeyPem = await exportSPKI(previousKeyPair.publicKey);
    const privateKeyPem = await exportPKCS8(keyPair.privateKey);
    const config = {
      get: (key: string) => {
        switch (key) {
          case 'JWT_PRIVATE_KEY_B64':
            return Buffer.from(privateKeyPem).toString('base64');
          case 'JWT_PUBLIC_KEY_B64':
            return Buffer.from(publicKeyPem).toString('base64');
          case 'JWT_KEY_ID':
            return 'test-key';
          case 'JWT_PREVIOUS_KEY_ID':
            return 'previous-key';
          case 'JWT_PREVIOUS_PUBLIC_KEY_B64':
            return Buffer.from(previousPublicKeyPem).toString('base64');
          case 'JWT_ISSUER':
            return ISSUER;
          case 'JWT_AUDIENCE':
            return AUDIENCE;
          case 'REFRESH_TOKEN_TTL_DAYS':
            return 30;
          default:
            return undefined;
        }
      },
    } as ConfigService<Environment, true>;
    repository = {
      findUserState: vi.fn(),
      hasActiveRefreshTokenFamily: vi.fn().mockResolvedValue(true),
      findUserProfile: vi.fn(),
      findRefreshByHash: vi.fn(),
      createOrUpdateGoogleUser: vi.fn(),
      createRefreshToken: vi.fn(),
      revokeFamily: vi.fn().mockResolvedValue({ count: 0 }),
      rotateRefreshToken: vi.fn(),
    } as unknown as AuthRepository;
    service = new AuthService(config, repository);
    await service.onModuleInit();
    userId = randomUUID();
  });

  it('rejects expired access tokens', async () => {
    const token = await createAccessToken({
      privateKey,
      userId,
      issuedAt: Math.floor(Date.now() / 1000) - 1200,
      expiresAt: Math.floor(Date.now() / 1000) - 900,
    });

    await expect(service.authenticateAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.findUserState).not.toHaveBeenCalled();
  });

  it('returns only the authenticated user profile fields and rejects inactive accounts', async () => {
    vi.spyOn(repository, 'findUserProfile').mockResolvedValue({
      id: userId,
      email: 'student@example.edu',
      firstName: 'Campus',
      lastName: 'Student',
      avatarUrl: null,
      role: 'STUDENT',
      isActive: true,
      deletedAt: null,
    });

    await expect(service.getProfile(userId)).resolves.toEqual({
      id: userId,
      email: 'student@example.edu',
      firstName: 'Campus',
      lastName: 'Student',
      avatarUrl: null,
      role: 'STUDENT',
    });

    vi.mocked(repository.findUserProfile).mockResolvedValue({
      id: userId,
      email: 'student@example.edu',
      firstName: 'Campus',
      lastName: 'Student',
      avatarUrl: null,
      role: 'STUDENT',
      isActive: false,
      deletedAt: null,
    });
    await expect(service.getProfile(userId)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects tampered access-token signatures', async () => {
    const validToken = await createAccessToken({
      privateKey,
      userId,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });
    const [header, payload, signature] = validToken.split('.');
    const changedSignature = `${signature?.[0] === 'a' ? 'b' : 'a'}${signature?.slice(1)}`;

    await expect(
      service.authenticateAccessToken(`${header}.${payload}.${changedSignature}`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repository.findUserState).not.toHaveBeenCalled();
  });

  it('rejects a token using a symmetric algorithm instead of RS256', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      role: 'STUDENT',
      tokenVersion: 0,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(new TextEncoder().encode('attacker-controlled-symmetric-key'));

    await expect(service.authenticateAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.findUserState).not.toHaveBeenCalled();
  });

  it.each([
    ['issuer', { issuer: 'https://attacker.invalid' }],
    ['audience', { audience: 'another-api' }],
  ] as const)('rejects a token with an invalid %s', async (_label, claims) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createAccessToken({
      privateKey,
      userId,
      issuedAt: now,
      expiresAt: now + 900,
      ...claims,
    });

    await expect(service.authenticateAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.findUserState).not.toHaveBeenCalled();
  });

  it('revokes the complete refresh-token family when a consumed token is replayed', async () => {
    const familyId = randomUUID();
    const record = {
      id: randomUUID(),
      userId,
      familyId,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date(),
      tokenVersion: 0,
      replacedById: null,
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(),
      user: {
        id: userId,
        role: 'STUDENT',
        tokenVersion: 0,
        isActive: true,
        deletedAt: null,
      },
    } as RefreshRecord;
    vi.spyOn(repository, 'findRefreshByHash').mockResolvedValue(record);

    await expect(service.refresh('A'.repeat(43))).rejects.toThrow('Refresh token reuse detected.');
    expect(repository.revokeFamily).toHaveBeenCalledWith(familyId, expect.any(Date));
  });

  it('rejects a tampered refresh cookie that does not match a stored token hash', async () => {
    vi.spyOn(repository, 'findRefreshByHash').mockResolvedValue(null);
    const tamperedCookie = 'A'.repeat(43);

    await expect(service.refresh(tamperedCookie)).rejects.toThrow(
      'Refresh token is missing or invalid.',
    );

    const [tokenHash] = vi.mocked(repository.findRefreshByHash).mock.calls[0] ?? [];
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toBe(tamperedCookie);
  });

  it('rejects a signature made with the configured public key rather than its private pair', async () => {
    const { privateKey: unrelatedPrivateKey } = await generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    });
    const token = await createAccessToken({
      privateKey: unrelatedPrivateKey,
      userId,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });

    await expect(service.authenticateAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.findUserState).not.toHaveBeenCalled();
  });

  it('accepts a valid token only when the current database role and version agree', async () => {
    const now = Math.floor(Date.now() / 1000);
    const user: AuthUserState = {
      id: userId,
      role: 'STUDENT',
      tokenVersion: 2,
      isActive: true,
      deletedAt: null,
    };
    vi.spyOn(repository, 'findUserState').mockResolvedValue(user);
    const token = await createAccessToken({
      privateKey,
      userId,
      role: 'STUDENT',
      tokenVersion: 2,
      issuedAt: now,
      expiresAt: now + 900,
    });

    await expect(service.authenticateAccessToken(token)).resolves.toEqual({
      id: userId,
      role: 'STUDENT',
      tokenVersion: 2,
    });
  });

  it('rejects a valid access token when its refresh-token family has been revoked', async () => {
    vi.spyOn(repository, 'findUserState').mockResolvedValue({
      id: userId,
      role: 'STUDENT',
      tokenVersion: 0,
      isActive: true,
      deletedAt: null,
    });
    vi.spyOn(repository, 'hasActiveRefreshTokenFamily').mockResolvedValue(false);
    const token = await createAccessToken({
      privateKey,
      userId,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    });

    await expect(service.authenticateAccessToken(token)).rejects.toThrow(
      'Access token is no longer valid.',
    );
    expect(repository.hasActiveRefreshTokenFamily).toHaveBeenCalledWith(
      userId,
      expect.any(String),
      0,
      expect.any(Date),
    );
  });

  it('verifies tokens signed by the configured previous key ID', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(repository, 'findUserState').mockResolvedValue({
      id: userId,
      role: 'STUDENT',
      tokenVersion: 0,
      isActive: true,
      deletedAt: null,
    });
    const token = await createAccessToken({
      privateKey: previousPrivateKey,
      keyId: 'previous-key',
      userId,
      issuedAt: now,
      expiresAt: now + 900,
    });

    await expect(service.authenticateAccessToken(token)).resolves.toMatchObject({
      id: userId,
      role: 'STUDENT',
    });
  });

  it('rejects a token whose key ID is not in the current/previous allowlist', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createAccessToken({
      privateKey,
      keyId: 'unrecognized-key',
      userId,
      issuedAt: now,
      expiresAt: now + 900,
    });

    await expect(service.authenticateAccessToken(token)).rejects.toThrow(
      'Access token key ID is not recognized.',
    );
    expect(repository.findUserState).not.toHaveBeenCalled();
  });
});

async function createAccessToken(input: {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  userId: string;
  role?: 'STUDENT' | 'ORGANIZER' | 'ADMIN';
  keyId?: string;
  issuer?: string;
  audience?: string;
  tokenVersion?: number;
  issuedAt: number;
  expiresAt: number;
}): Promise<string> {
  return new SignJWT({
    role: input.role ?? 'STUDENT',
    tokenVersion: input.tokenVersion ?? 0,
    sid: randomUUID(),
  })
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'JWT',
      kid: input.keyId ?? 'test-key',
    })
    .setIssuer(input.issuer ?? ISSUER)
    .setAudience(input.audience ?? AUDIENCE)
    .setSubject(input.userId)
    .setJti(randomUUID())
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.expiresAt)
    .sign(input.privateKey);
}
