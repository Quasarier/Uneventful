import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Environment } from '../config/environment';

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const tokenResponseSchema = z.object({
  id_token: z.string().min(1).max(16_384),
});

const identityClaimsSchema = z.object({
  sub: z.string().min(1).max(255),
  hd: z.string().min(1).max(253),
  email: z.string().email().max(320),
  email_verified: z.literal(true),
  nonce: z.string().min(1),
  given_name: z.string().max(100).optional(),
  family_name: z.string().max(100).optional(),
  name: z.string().max(201).optional(),
  picture: z.string().url().max(2048).optional(),
});

const oauthTransactionSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/),
  createdAt: z.number().int().positive(),
});

export interface GoogleIdentity {
  googleSubject: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

export interface GoogleLoginStart {
  authorizationUrl: string;
  transactionCookie: string;
}

export function validateGoogleIdentityClaims(
  payload: unknown,
  expectedDomain: string,
  expectedNonce: string,
): GoogleIdentity {
  const parsed = identityClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UnauthorizedException('Google identity could not be verified.');
  }

  const claims = parsed.data;
  const email = claims.email.toLowerCase();
  const emailDomain = email.slice(email.lastIndexOf('@') + 1);
  const leftNonce = Buffer.from(claims.nonce);
  const rightNonce = Buffer.from(expectedNonce);
  if (
    leftNonce.length !== rightNonce.length ||
    !timingSafeEqual(leftNonce, rightNonce) ||
    claims.hd.toLowerCase() !== expectedDomain ||
    emailDomain !== expectedDomain
  ) {
    throw new UnauthorizedException('A verified university account is required.');
  }

  const nameParts = claims.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const firstName = (claims.given_name ?? nameParts[0] ?? '').trim();
  const lastName = (claims.family_name ?? nameParts.slice(1).join(' ')).trim();
  if (!firstName || firstName.length > 100 || lastName.length > 100) {
    throw new UnauthorizedException('Google profile information is incomplete.');
  }

  return {
    googleSubject: claims.sub,
    email,
    firstName,
    lastName,
    avatarUrl:
      claims.picture && new URL(claims.picture).protocol === 'https:' ? claims.picture : null,
  };
}

@Injectable()
export class GoogleOidcService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  createLoginStart(): GoogleLoginStart {
    const state = this.randomToken();
    const nonce = this.randomToken();
    const verifier = this.randomToken();
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.get('GOOGLE_CLIENT_ID', { infer: true }),
      redirect_uri: this.config.get('GOOGLE_CALLBACK_URL', { infer: true }),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      hd: this.config.get('UNIVERSITY_EMAIL_DOMAIN', { infer: true }),
      prompt: 'select_account',
    }).toString();

    const transaction = {
      state,
      nonce,
      verifier,
      createdAt: Date.now(),
    };

    return {
      authorizationUrl: url.toString(),
      transactionCookie: this.signTransaction(transaction),
    };
  }

  async verifyCallback(
    code: string,
    callbackState: string,
    transactionCookie: string | undefined,
  ): Promise<GoogleIdentity> {
    const transaction = this.verifyTransaction(transactionCookie);
    if (!this.constantTimeEquals(transaction.state, callbackState)) {
      throw new UnauthorizedException('OAuth state validation failed.');
    }

    const body = new URLSearchParams({
      code,
      client_id: this.config.get('GOOGLE_CLIENT_ID', { infer: true }),
      client_secret: this.config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      redirect_uri: this.config.get('GOOGLE_CALLBACK_URL', { infer: true }),
      grant_type: 'authorization_code',
      code_verifier: transaction.verifier,
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new UnauthorizedException('Google authorization failed.');
    }

    const responseBody: unknown = await response.json();
    const parsedTokenResponse = tokenResponseSchema.safeParse(responseBody);
    if (!parsedTokenResponse.success) {
      throw new UnauthorizedException('Google authorization failed.');
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(parsedTokenResponse.data.id_token, GOOGLE_JWKS, {
        issuer: GOOGLE_ISSUERS,
        audience: this.config.get('GOOGLE_CLIENT_ID', { infer: true }),
        algorithms: ['RS256'],
        clockTolerance: 5,
      }));
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) {
        throw new UnauthorizedException('Google identity could not be verified.');
      }
      throw error;
    }
    return validateGoogleIdentityClaims(
      payload,
      this.config.get('UNIVERSITY_EMAIL_DOMAIN', { infer: true }),
      transaction.nonce,
    );
  }

  private randomToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private signTransaction(transaction: z.infer<typeof oauthTransactionSchema>): string {
    const payload = Buffer.from(JSON.stringify(transaction)).toString('base64url');
    const signature = createHmac('sha256', this.config.get('SESSION_SECRET', { infer: true }))
      .update(payload)
      .digest('base64url');

    return `${payload}.${signature}`;
  }

  private verifyTransaction(cookie: string | undefined): z.infer<typeof oauthTransactionSchema> {
    if (!cookie || cookie.length > 2048) {
      throw new UnauthorizedException('OAuth transaction is missing or invalid.');
    }

    const separator = cookie.lastIndexOf('.');
    if (separator <= 0) {
      throw new UnauthorizedException('OAuth transaction is missing or invalid.');
    }

    const payload = cookie.slice(0, separator);
    const providedSignature = cookie.slice(separator + 1);
    const expectedSignature = createHmac(
      'sha256',
      this.config.get('SESSION_SECRET', { infer: true }),
    )
      .update(payload)
      .digest();
    let suppliedSignature: Buffer;
    try {
      suppliedSignature = Buffer.from(providedSignature, 'base64url');
    } catch {
      throw new UnauthorizedException('OAuth transaction is missing or invalid.');
    }

    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new UnauthorizedException('OAuth transaction is missing or invalid.');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('OAuth transaction is missing or invalid.');
    }
    const parsed = oauthTransactionSchema.safeParse(decoded);
    if (
      !parsed.success ||
      parsed.data.createdAt > Date.now() + 30_000 ||
      Date.now() - parsed.data.createdAt > 10 * 60_000
    ) {
      throw new UnauthorizedException('OAuth transaction is missing or expired.');
    }

    return parsed.data;
  }

  private constantTimeEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
