import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export type PushHostLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

export class PushEndpointResolutionError extends Error {
  constructor() {
    super('Push endpoint could not be resolved.');
  }
}

export const resolvePushHost: PushHostLookup = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function ipv4ToBigInt(address: string): bigint | undefined {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6ToBigInt(address: string): bigint | undefined {
  const addressWithoutScope = address.toLowerCase().split('%')[0];
  if (!addressWithoutScope) {
    return undefined;
  }
  let value = addressWithoutScope;
  if (value.includes('.')) {
    const lastSeparator = value.lastIndexOf(':');
    const ipv4 = ipv4ToBigInt(value.slice(lastSeparator + 1));
    if (ipv4 === undefined) {
      return undefined;
    }
    value = `${value.slice(0, lastSeparator)}:${Number((ipv4 >> 16n) & 0xffffn).toString(16)}:${Number(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const parseGroups = (half: string): number[] => {
    if (!half) {
      return [];
    }
    return half
      .split(':')
      .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : -1));
  };
  const left = parseGroups(halves[0] ?? '');
  const right = parseGroups(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if (
    left.some((group) => group < 0) ||
    right.some((group) => group < 0) ||
    (halves.length === 1 ? missing !== 0 : missing < 1)
  ) {
    return undefined;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right].reduce(
    (result, group) => (result << 16n) | BigInt(group),
    0n,
  );
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToBigInt(address);
    if (value === undefined) {
      return false;
    }
    const blockedRanges: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return !blockedRanges.some(([network, prefix]) => {
      const base = ipv4ToBigInt(network);
      return base !== undefined && value >> BigInt(32 - prefix) === base >> BigInt(32 - prefix);
    });
  }
  if (family === 6) {
    const value = ipv6ToBigInt(address);
    if (value === undefined || value >> 125n !== 1n) {
      return false;
    }
    return (
      value >> 96n !== 0x20010db8n && value >> 96n !== 0x20010000n && value >> 112n !== 0x2002n
    );
  }
  return false;
}

export async function isSafePushEndpoint(
  endpoint: string,
  hostLookup: PushHostLookup = resolvePushHost,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port !== '' && url.port !== '443')
  ) {
    return false;
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return false;
  }
  const family = isIP(hostname);
  if (family !== 0) {
    return isPublicIpAddress(hostname);
  }
  if (!hostname.includes('.')) {
    return false;
  }

  let records: readonly { address: string; family: number }[];
  try {
    records = await hostLookup(hostname);
  } catch {
    throw new PushEndpointResolutionError();
  }
  return records.length > 0 && records.every(({ address }) => isPublicIpAddress(address));
}
