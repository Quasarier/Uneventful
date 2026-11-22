import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import type { Environment } from '../config/environment';
import { describe, expect, it } from 'vitest';
import { TicketSigningService } from './ticket-signing.service';

function encodedKey(key: ReturnType<typeof generateKeyPairSync>['privateKey']): string {
  return Buffer.from(key.export({ format: 'der', type: 'pkcs8' })).toString('base64');
}

function encodedPublicKey(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return Buffer.from(key.export({ format: 'der', type: 'spki' })).toString('base64');
}

function createSigner(
  current: ReturnType<typeof generateKeyPairSync>,
  currentKid = 'current-ticket-key',
  previous?: { kid: string; publicKey: string },
): TicketSigningService {
  const values = new Map<string, string | undefined>([
    ['TICKET_SIGNING_PRIVATE_KEY_B64', encodedKey(current.privateKey)],
    ['TICKET_SIGNING_PUBLIC_KEY_B64', encodedPublicKey(current.publicKey)],
    ['TICKET_SIGNING_KEY_ID', currentKid],
    ['TICKET_SIGNING_PREVIOUS_KEY_ID', previous?.kid],
    ['TICKET_SIGNING_PREVIOUS_PUBLIC_KEY_B64', previous?.publicKey],
  ]);
  const config = {
    get: (key: string) => values.get(key),
  } as unknown as ConfigService<Environment, true>;
  return new TicketSigningService(config);
}

function keys() {
  return generateKeyPairSync('ed25519');
}

describe('TicketSigningService', () => {
  it('signs the exact compact Ed25519 ticket claims with the configured kid', () => {
    const signingKeys = keys();
    const signer = createSigner(signingKeys);
    const expiresAt = new Date(Date.now() + 60_000);
    const ticket = {
      ticketId: '4c39f095-8aa2-4e16-bc01-ed47a7e2a138',
      eventId: '6a649ea9-a69c-4980-87bd-f89bc0790e29',
      rsvpId: 'c32ed6aa-a332-44de-9999-1c23ce9aed7a',
    };
    const token = signer.issue(ticket, expiresAt);
    const [header] = token.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'));

    expect(decodedHeader).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'current-ticket-key' });
    expect(signer.verify(token)).toMatchObject({
      ...ticket,
      expiresAt: expiresAt.getTime(),
    });
  });

  it('verifies tokens signed by the previous public key during rotation', () => {
    const previousKeys = keys();
    const previousSigner = createSigner(previousKeys, 'previous-ticket-key');
    const oldToken = previousSigner.issue(
      {
        ticketId: '4c39f095-8aa2-4e16-bc01-ed47a7e2a138',
        eventId: '6a649ea9-a69c-4980-87bd-f89bc0790e29',
        rsvpId: 'c32ed6aa-a332-44de-9999-1c23ce9aed7a',
      },
      new Date(Date.now() + 60_000),
    );
    const currentKeys = keys();
    const rotatedSigner = createSigner(currentKeys, 'current-ticket-key', {
      kid: 'previous-ticket-key',
      publicKey: encodedPublicKey(previousKeys.publicKey),
    });

    expect(rotatedSigner.verify(oldToken).eventId).toBe('6a649ea9-a69c-4980-87bd-f89bc0790e29');
    expect(rotatedSigner.publicKeySet().keys.map((entry) => entry.kid)).toEqual([
      'current-ticket-key',
      'previous-ticket-key',
    ]);
  });

  it('rejects tampered, expired, unknown-kid and mismatched private/public key material', () => {
    const signingKeys = keys();
    const signer = createSigner(signingKeys);
    const token = signer.issue(
      {
        ticketId: '4c39f095-8aa2-4e16-bc01-ed47a7e2a138',
        eventId: '6a649ea9-a69c-4980-87bd-f89bc0790e29',
        rsvpId: 'c32ed6aa-a332-44de-9999-1c23ce9aed7a',
      },
      new Date(Date.now() + 60_000),
    );
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${Buffer.from('{"ticketId":"tampered"}').toString('base64url')}.${signature}`;
    const unknownKid = `${Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'unknown' }),
    ).toString('base64url')}.${payload}.${signature}`;
    const expired = signer.issue(
      {
        ticketId: '4c39f095-8aa2-4e16-bc01-ed47a7e2a138',
        eventId: '6a649ea9-a69c-4980-87bd-f89bc0790e29',
        rsvpId: 'c32ed6aa-a332-44de-9999-1c23ce9aed7a',
      },
      new Date(Date.now() - 1),
    );
    const mismatchedConfig = {
      get: (key: string) =>
        new Map([
          ['TICKET_SIGNING_PRIVATE_KEY_B64', encodedKey(signingKeys.privateKey)],
          ['TICKET_SIGNING_PUBLIC_KEY_B64', encodedPublicKey(keys().publicKey)],
          ['TICKET_SIGNING_KEY_ID', 'mismatched'],
        ]).get(key),
    } as unknown as ConfigService<Environment, true>;

    expect(() => signer.verify(tampered)).toThrow('Invalid ticket.');
    expect(() => signer.verify(unknownKid)).toThrow('Invalid ticket.');
    expect(() => signer.verify(expired)).toThrow('Invalid ticket.');
    expect(() => new TicketSigningService(mismatchedConfig)).toThrow(
      'Ticket signing private and public keys do not match.',
    );
  });
});
