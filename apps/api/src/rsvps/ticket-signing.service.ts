import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import type { Environment } from '../config/environment';

export interface TicketClaims {
  ticketId: string;
  eventId: string;
  rsvpId: string;
  issuedAt: number;
  expiresAt: number;
}

interface TicketHeader {
  alg: 'EdDSA';
  typ: 'JWT';
  kid: string;
}

const TICKET_EXPIRY_GRACE_MS = 2 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new UnauthorizedException('Invalid ticket.');
  }
  return decoded;
}

function parseJsonObject(value: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch {
    throw new UnauthorizedException('Invalid ticket.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnauthorizedException('Invalid ticket.');
  }
  return parsed as Record<string, unknown>;
}

function importPrivateKey(encoded: string): KeyObject {
  const key = createPrivateKey({
    key: Buffer.from(encoded, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Ticket signing private key must be Ed25519.');
  }
  return key;
}

function importPublicKey(encoded: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(encoded, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Ticket signing public key must be Ed25519.');
  }
  return key;
}

@Injectable()
export class TicketSigningService {
  private readonly currentKeyId: string;
  private readonly privateKey: KeyObject;
  private readonly verificationKeys: ReadonlyMap<string, KeyObject>;

  constructor(config: ConfigService<Environment, true>) {
    this.currentKeyId = config.get('TICKET_SIGNING_KEY_ID', { infer: true });
    this.privateKey = importPrivateKey(
      config.get('TICKET_SIGNING_PRIVATE_KEY_B64', { infer: true }),
    );
    const currentPublicKey = importPublicKey(
      config.get('TICKET_SIGNING_PUBLIC_KEY_B64', { infer: true }),
    );
    const derivedPublicKey = createPublicKey(this.privateKey).export({
      format: 'der',
      type: 'spki',
    });
    const configuredPublicKey = currentPublicKey.export({ format: 'der', type: 'spki' });
    if (!derivedPublicKey.equals(configuredPublicKey)) {
      throw new Error('Ticket signing private and public keys do not match.');
    }

    const keys = new Map<string, KeyObject>([[this.currentKeyId, currentPublicKey]]);
    const previousKeyId = config.get('TICKET_SIGNING_PREVIOUS_KEY_ID', { infer: true });
    const previousPublicKey = config.get('TICKET_SIGNING_PREVIOUS_PUBLIC_KEY_B64', {
      infer: true,
    });
    if (previousKeyId && previousPublicKey) {
      keys.set(previousKeyId, importPublicKey(previousPublicKey));
    }
    this.verificationKeys = keys;
  }

  static expiresAt(eventEndAt: Date): Date {
    return new Date(eventEndAt.getTime() + TICKET_EXPIRY_GRACE_MS);
  }

  static hashTicketId(ticketId: string): string {
    return createHash('sha256').update(ticketId).digest('hex');
  }

  issue(ticket: Omit<TicketClaims, 'issuedAt' | 'expiresAt'>, expiresAt: Date): string {
    const claims: TicketClaims = {
      ...ticket,
      issuedAt: Date.now(),
      expiresAt: expiresAt.getTime(),
    };
    const header: TicketHeader = { alg: 'EdDSA', typ: 'JWT', kid: this.currentKeyId };
    const unsigned = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}`;
    return `${unsigned}.${signBytes(null, Buffer.from(unsigned), this.privateKey).toString('base64url')}`;
  }

  verify(token: string): TicketClaims {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new UnauthorizedException('Invalid ticket.');
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !encodedSignature) {
      throw new UnauthorizedException('Invalid ticket.');
    }

    const header = parseJsonObject(decodeBase64Url(encodedHeader));
    if (
      header.alg !== 'EdDSA' ||
      header.typ !== 'JWT' ||
      typeof header.kid !== 'string' ||
      Object.keys(header).some((key) => !['alg', 'typ', 'kid'].includes(key))
    ) {
      throw new UnauthorizedException('Invalid ticket.');
    }
    const key = this.verificationKeys.get(header.kid);
    if (!key) {
      throw new UnauthorizedException('Invalid ticket.');
    }

    const unsigned = `${encodedHeader}.${encodedClaims}`;
    if (!verifyBytes(null, Buffer.from(unsigned), key, decodeBase64Url(encodedSignature))) {
      throw new UnauthorizedException('Invalid ticket.');
    }

    const claims = parseJsonObject(decodeBase64Url(encodedClaims));
    if (
      Object.keys(claims).length !== 5 ||
      typeof claims.ticketId !== 'string' ||
      !UUID_PATTERN.test(claims.ticketId) ||
      typeof claims.eventId !== 'string' ||
      !UUID_PATTERN.test(claims.eventId) ||
      typeof claims.rsvpId !== 'string' ||
      !UUID_PATTERN.test(claims.rsvpId) ||
      typeof claims.issuedAt !== 'number' ||
      !Number.isSafeInteger(claims.issuedAt) ||
      typeof claims.expiresAt !== 'number' ||
      !Number.isSafeInteger(claims.expiresAt) ||
      (claims.issuedAt as number) > Date.now() + MAX_CLOCK_SKEW_MS ||
      (claims.expiresAt as number) <= Date.now() ||
      (claims.expiresAt as number) <= (claims.issuedAt as number)
    ) {
      throw new UnauthorizedException('Invalid ticket.');
    }
    return {
      ticketId: claims.ticketId,
      eventId: claims.eventId,
      rsvpId: claims.rsvpId,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    };
  }

  publicKeySet(): { currentKid: string; keys: Array<{ kid: string; publicKey: string }> } {
    return {
      currentKid: this.currentKeyId,
      keys: [...this.verificationKeys].map(([kid, key]) => ({
        kid,
        publicKey: key.export({ format: 'der', type: 'spki' }).toString('base64url'),
      })),
    };
  }
}
