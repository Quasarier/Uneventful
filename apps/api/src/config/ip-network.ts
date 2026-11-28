import { isIP } from 'node:net';

interface ParsedAddress {
  bits: 32 | 128;
  value: bigint;
}

interface ParsedNetwork extends ParsedAddress {
  prefix: number;
}

function parseAddress(input: string): ParsedAddress | null {
  const version = isIP(input);
  if (version === 4) {
    const octets = input.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
      return null;
    }
    return {
      bits: 32,
      value: octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n),
    };
  }
  if (version !== 6) {
    return null;
  }

  let normalized = input.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) {
      return null;
    }
    const octets = ipv4.split('.').map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = `${normalized.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const compression = normalized.indexOf('::');
  const parts =
    compression === -1
      ? normalized.split(':')
      : [
          ...normalized.slice(0, compression).split(':').filter(Boolean),
          ...Array.from({
            length:
              8 -
              normalized.slice(0, compression).split(':').filter(Boolean).length -
              normalized
                .slice(compression + 2)
                .split(':')
                .filter(Boolean).length,
          }).map(() => '0'),
          ...normalized
            .slice(compression + 2)
            .split(':')
            .filter(Boolean),
        ];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  const value = parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
  if (value >> 32n === 0xffffn) {
    return { bits: 32, value: value & 0xffff_ffffn };
  }
  return { bits: 128, value };
}

function parseNetwork(value: string): ParsedNetwork | null {
  const [addressText, prefixText, ...extra] = value.split('/');
  if (!addressText || extra.length > 0) {
    return null;
  }
  const address = parseAddress(addressText);
  if (!address) {
    return null;
  }
  if (prefixText === undefined) {
    return { ...address, prefix: address.bits };
  }
  if (!/^(0|[1-9]\d*)$/.test(prefixText)) {
    return null;
  }
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) {
    return null;
  }
  return { ...address, prefix };
}

export function isValidAdminIpAllowlist(value: string): boolean {
  if (value === '') {
    return true;
  }
  const entries = value.split(',').map((entry) => entry.trim());
  return entries.every((entry) => entry.length > 0 && parseNetwork(entry) !== null);
}

export function isAdminIpAllowed(value: string, remoteAddress: string): boolean {
  if (value === '') {
    return true;
  }
  const address = parseAddress(remoteAddress);
  if (!address) {
    return false;
  }
  return value.split(',').some((entry) => {
    const network = parseNetwork(entry.trim());
    if (!network || network.bits !== address.bits) {
      return false;
    }
    const mask =
      network.prefix === 0
        ? 0n
        : ((1n << BigInt(network.prefix)) - 1n) << BigInt(network.bits - network.prefix);
    return (address.value & mask) === (network.value & mask);
  });
}
