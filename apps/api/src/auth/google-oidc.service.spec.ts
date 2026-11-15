import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../config/environment';
import { GoogleOidcService, validateGoogleIdentityClaims } from './google-oidc.service';

describe('GoogleOidcService', () => {
  function createService(): GoogleOidcService {
    const config = {
      get: (key: string) => {
        switch (key) {
          case 'GOOGLE_CLIENT_ID':
            return 'uneventful-test-client';
          case 'GOOGLE_CLIENT_SECRET':
            return 'uneventful-test-secret';
          case 'GOOGLE_CALLBACK_URL':
            return 'http://localhost:3001/api/v1/auth/google/callback';
          case 'UNIVERSITY_EMAIL_DOMAIN':
            return 'example.edu';
          case 'SESSION_SECRET':
            return 'test-session-secret-with-more-than-thirty-two-characters';
          default:
            return undefined;
        }
      },
    } as ConfigService<Environment, true>;
    return new GoogleOidcService(config);
  }

  it('creates a stateful OIDC request using an S256 PKCE challenge', () => {
    const service = createService();

    const login = service.createLoginStart();
    const authorization = new URL(login.authorizationUrl);
    const [payload] = login.transactionCookie.split('.');
    const transaction = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      state: string;
      nonce: string;
      verifier: string;
    };
    const expectedChallenge = createHash('sha256').update(transaction.verifier).digest('base64url');

    expect(authorization.origin + authorization.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('state')).toBe(transaction.state);
    expect(authorization.searchParams.get('nonce')).toBe(transaction.nonce);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBe(expectedChallenge);
    expect(authorization.searchParams.get('hd')).toBe('example.edu');
  });

  it('creates a fresh OAuth transaction for each login attempt', () => {
    const service = createService();
    const first = service.createLoginStart();
    const second = service.createLoginStart();

    expect(first.transactionCookie).not.toBe(second.transactionCookie);
    expect(new URL(first.authorizationUrl).searchParams.get('state')).not.toBe(
      new URL(second.authorizationUrl).searchParams.get('state'),
    );
  });

  it('rejects a callback with a state value that differs from the signed transaction', async () => {
    const login = createService().createLoginStart();
    const authorization = new URL(login.authorizationUrl);

    await expect(
      createService().verifyCallback(
        'authorization-code',
        `${authorization.searchParams.get('state')}x`,
        login.transactionCookie,
      ),
    ).rejects.toThrow('OAuth state validation failed.');
  });

  it('rejects a transaction cookie with a tampered signature', async () => {
    const service = createService();
    const login = service.createLoginStart();
    const authorization = new URL(login.authorizationUrl);
    const [payload, signature] = login.transactionCookie.split('.');
    const tamperedSignature = `${signature?.[0] === 'A' ? 'B' : 'A'}${signature?.slice(1)}`;

    await expect(
      service.verifyCallback(
        'authorization-code',
        authorization.searchParams.get('state') ?? '',
        `${payload}.${tamperedSignature}`,
      ),
    ).rejects.toThrow('OAuth transaction is missing or invalid.');
  });

  it('rejects a callback without the PKCE transaction cookie', async () => {
    await expect(
      createService().verifyCallback('authorization-code', 'state-value', undefined),
    ).rejects.toThrow('OAuth transaction is missing or invalid.');
  });

  it('sends the PKCE verifier with the authorization-code exchange', async () => {
    const service = createService();
    const login = service.createLoginStart();
    const authorization = new URL(login.authorizationUrl);
    const state = authorization.searchParams.get('state');
    const [encodedTransaction] = login.transactionCookie.split('.');
    const transaction = JSON.parse(
      Buffer.from(encodedTransaction ?? '', 'base64url').toString('utf8'),
    ) as { verifier: string };
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id_token: 'not-a-valid-id-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        service.verifyCallback('authorization-code', state ?? '', login.transactionCookie),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      const requestOptions = fetchMock.mock.calls[0]?.[1];
      expect(requestOptions?.body).toBeInstanceOf(URLSearchParams);
      if (!(requestOptions?.body instanceof URLSearchParams)) {
        throw new Error('Expected a URL-encoded OAuth token request.');
      }
      expect(requestOptions.body.get('code_verifier')).toBe(transaction.verifier);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts only a verified exact-domain identity with the transaction nonce', () => {
    expect(
      validateGoogleIdentityClaims(
        {
          sub: 'google-subject-1',
          hd: 'EXAMPLE.EDU',
          email: 'Student@Example.edu',
          email_verified: true,
          nonce: 'transaction-nonce',
          given_name: 'Student',
          family_name: 'User',
        },
        'example.edu',
        'transaction-nonce',
      ),
    ).toEqual({
      googleSubject: 'google-subject-1',
      email: 'student@example.edu',
      firstName: 'Student',
      lastName: 'User',
      avatarUrl: null,
    });
  });

  it.each([
    {
      label: 'unverified email',
      changes: { email_verified: false },
    },
    {
      label: 'mismatched hosted domain',
      changes: { hd: 'attacker.example' },
    },
    {
      label: 'lookalike email domain',
      changes: { email: 'student@example.edu.attacker.invalid' },
    },
    {
      label: 'mismatched nonce',
      changes: { nonce: 'other-transaction' },
    },
  ])('rejects $label', ({ changes }) => {
    expect(() =>
      validateGoogleIdentityClaims(
        {
          sub: 'google-subject-1',
          hd: 'example.edu',
          email: 'student@example.edu',
          email_verified: true,
          nonce: 'transaction-nonce',
          given_name: 'Student',
          family_name: 'User',
          ...changes,
        },
        'example.edu',
        'transaction-nonce',
      ),
    ).toThrow(UnauthorizedException);
  });
});
