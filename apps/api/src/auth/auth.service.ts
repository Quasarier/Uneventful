import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  decodeProtectedHeader,
  errors as joseErrors,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from 'jose';
import { z } from 'zod';
import type { Environment } from '../config/environment';
import {
  AuthRepository,
  RefreshRotationConflictError,
  type AuthUser,
  type AuthUserState,
} from './auth.repository';
import type { AuthPrincipal } from './auth.types';
import type { GoogleIdentity } from './google-oidc.service';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const accessClaimsSchema = z
  .object({
    sub: z.string().uuid(),
    role: z.enum(['STUDENT', 'ORGANIZER', 'ADMIN']),
    tokenVersion: z.number().int().nonnegative(),
    sid: z.string().uuid(),
    jti: z.string().uuid(),
    iss: z.string().url(),
    aud: z.union([z.string(), z.array(z.string())]),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: typeof ACCESS_TOKEN_TTL_SECONDS;
}

export interface AuthenticatedAccessSession {
  principal: AuthPrincipal;
  familyId: string;
  expiresAt: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private signingKey!: Awaited<ReturnType<typeof importPKCS8>>;
  private verificationKeys!: Map<string, Awaited<ReturnType<typeof importSPKI>>>;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: AuthRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const privateKey = Buffer.from(
      this.config.get('JWT_PRIVATE_KEY_B64', { infer: true }),
      'base64',
    ).toString('utf8');
    const publicKey = Buffer.from(
      this.config.get('JWT_PUBLIC_KEY_B64', { infer: true }),
      'base64',
    ).toString('utf8');
    const currentKeyId = this.config.get('JWT_KEY_ID', { infer: true });

    this.signingKey = await importPKCS8(privateKey, 'RS256');
    this.verificationKeys = new Map([[currentKeyId, await importSPKI(publicKey, 'RS256')]]);

    const previousKeyId = this.config.get('JWT_PREVIOUS_KEY_ID', { infer: true });
    const previousPublicKey = this.config.get('JWT_PREVIOUS_PUBLIC_KEY_B64', {
      infer: true,
    });
    if (previousKeyId && previousPublicKey) {
      this.verificationKeys.set(
        previousKeyId,
        await importSPKI(Buffer.from(previousPublicKey, 'base64').toString('utf8'), 'RS256'),
      );
    }

    const keyPairProof = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.config.get('JWT_ISSUER', { infer: true }))
      .setAudience(this.config.get('JWT_AUDIENCE', { infer: true }))
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(this.signingKey);
    const currentVerificationKey = this.verificationKeys.get(currentKeyId);
    if (!currentVerificationKey) {
      throw new Error('Current JWT verification key was not initialized.');
    }
    await jwtVerify(keyPairProof, currentVerificationKey, {
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: this.config.get('JWT_AUDIENCE', { infer: true }),
      algorithms: ['RS256'],
    });
  }

  async completeGoogleLogin(identity: GoogleIdentity): Promise<AuthSession> {
    const user = await this.repository.createOrUpdateGoogleUser(identity);
    return this.createSession(user);
  }

  async refresh(rawRefreshToken: string | undefined): Promise<AuthSession> {
    if (!rawRefreshToken || !/^[A-Za-z0-9_-]{43}$/.test(rawRefreshToken)) {
      throw new UnauthorizedException('Refresh token is missing or invalid.');
    }

    const record = await this.repository.findRefreshByHash(this.hashRefreshToken(rawRefreshToken));
    if (!record) {
      throw new UnauthorizedException('Refresh token is missing or invalid.');
    }

    const now = new Date();
    if (record.revokedAt) {
      await this.repository.revokeFamily(record.familyId, now);
      throw new UnauthorizedException('Refresh token reuse detected.');
    }
    if (record.expiresAt <= now) {
      await this.repository.revokeFamily(record.familyId, now);
      throw new UnauthorizedException('Refresh token has expired.');
    }

    if (!record.user.isActive || record.user.deletedAt) {
      await this.repository.revokeFamily(record.familyId, now);
      throw new UnauthorizedException('This account is unavailable.');
    }
    if (record.tokenVersion !== record.user.tokenVersion) {
      await this.repository.revokeFamily(record.familyId, now);
      throw new UnauthorizedException('Refresh token is no longer valid.');
    }

    const nextRefreshToken = this.newRefreshToken();
    try {
      await this.repository.rotateRefreshToken(
        record.id,
        record.tokenVersion,
        {
          id: randomUUID(),
          userId: record.userId,
          familyId: record.familyId,
          tokenHash: this.hashRefreshToken(nextRefreshToken),
          expiresAt: this.getRefreshExpiry(now),
          tokenVersion: record.tokenVersion,
          googleAuthenticatedAt: record.googleAuthenticatedAt,
        },
        now,
      );
    } catch (error) {
      if (!(error instanceof RefreshRotationConflictError)) {
        throw error;
      }
      await this.repository.revokeFamily(record.familyId, now);
      throw new UnauthorizedException('Refresh token reuse detected.');
    }

    return this.createSessionTokens(record.user, nextRefreshToken, record.familyId);
  }

  async logout(rawRefreshToken: string | undefined): Promise<string | undefined> {
    if (!rawRefreshToken || !/^[A-Za-z0-9_-]{43}$/.test(rawRefreshToken)) {
      return undefined;
    }

    const record = await this.repository.findRefreshByHash(this.hashRefreshToken(rawRefreshToken));
    if (record) {
      await this.repository.revokeFamily(record.familyId, new Date());
      return record.familyId;
    }
    return undefined;
  }

  async logoutAll(userId: string): Promise<void> {
    await this.repository.revokeUserSessions(userId, new Date());
  }

  async isAccessSessionActive(session: AuthenticatedAccessSession): Promise<boolean> {
    const user = await this.repository.findUserState(session.principal.id);
    if (
      !user ||
      !user.isActive ||
      user.deletedAt ||
      user.role !== session.principal.role ||
      user.tokenVersion !== session.principal.tokenVersion
    ) {
      return false;
    }
    return this.repository.hasActiveRefreshTokenFamily(
      user.id,
      session.familyId,
      session.principal.tokenVersion,
      new Date(),
    );
  }

  async getProfile(userId: string) {
    const user = await this.repository.findUserProfile(userId);
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('This account is unavailable.');
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    };
  }

  async authenticateAccessToken(token: string): Promise<AuthPrincipal> {
    const session = await this.authenticateAccessTokenSession(token);
    return session.principal;
  }

  async authenticateAccessTokenSession(token: string): Promise<AuthenticatedAccessSession> {
    try {
      const keyId = decodeProtectedHeader(token).kid;
      if (!keyId) {
        throw new UnauthorizedException('Access token key ID is missing.');
      }
      const verificationKey = this.verificationKeys.get(keyId);
      if (!verificationKey) {
        throw new UnauthorizedException('Access token key ID is not recognized.');
      }
      const { payload } = await jwtVerify(token, verificationKey, {
        issuer: this.config.get('JWT_ISSUER', { infer: true }),
        audience: this.config.get('JWT_AUDIENCE', { infer: true }),
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      const parsed = accessClaimsSchema.safeParse(payload);
      if (!parsed.success) {
        throw new UnauthorizedException('Access token is invalid.');
      }

      const claims = parsed.data;
      const user: AuthUserState | null = await this.repository.findUserState(claims.sub);
      if (
        !user ||
        !user.isActive ||
        user.deletedAt ||
        user.role !== claims.role ||
        user.tokenVersion !== claims.tokenVersion
      ) {
        throw new UnauthorizedException('Access token is no longer valid.');
      }
      const sessionIsActive = await this.repository.hasActiveRefreshTokenFamily(
        user.id,
        claims.sid,
        claims.tokenVersion,
        new Date(),
      );
      if (!sessionIsActive) {
        throw new UnauthorizedException('Access token is no longer valid.');
      }

      return {
        principal: {
          id: user.id,
          role: user.role,
          tokenVersion: user.tokenVersion,
        },
        familyId: claims.sid,
        expiresAt: claims.exp * 1_000,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (error instanceof joseErrors.JOSEError) {
        throw new UnauthorizedException('Access token is invalid or expired.');
      }
      throw error;
    }
  }

  getRefreshCookieMaxAgeMs(): number {
    return this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400_000;
  }

  private async createSession(user: AuthUser): Promise<AuthSession> {
    const refreshToken = this.newRefreshToken();
    const now = new Date();
    const familyId = randomUUID();
    await this.repository.createRefreshToken({
      id: randomUUID(),
      userId: user.id,
      familyId,
      tokenHash: this.hashRefreshToken(refreshToken),
      expiresAt: this.getRefreshExpiry(now),
      tokenVersion: user.tokenVersion,
      googleAuthenticatedAt: new Date(),
    });

    return this.createSessionTokens(user, refreshToken, familyId);
  }

  private async createSessionTokens(
    user: Pick<AuthUser, 'id' | 'role' | 'tokenVersion'>,
    refreshToken: string,
    familyId: string,
  ): Promise<AuthSession> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({
      role: user.role,
      tokenVersion: user.tokenVersion,
      sid: familyId,
    })
      .setProtectedHeader({
        alg: 'RS256',
        typ: 'JWT',
        kid: this.config.get('JWT_KEY_ID', { infer: true }),
      })
      .setIssuer(this.config.get('JWT_ISSUER', { infer: true }))
      .setAudience(this.config.get('JWT_AUDIENCE', { infer: true }))
      .setSubject(user.id)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.signingKey);

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private getRefreshExpiry(now: Date): Date {
    const expiry = new Date(now);
    expiry.setUTCDate(
      expiry.getUTCDate() + this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }),
    );
    return expiry;
  }
}
