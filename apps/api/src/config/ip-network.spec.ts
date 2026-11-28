import { describe, expect, it } from 'vitest';
import { isAdminIpAllowed, isValidAdminIpAllowlist } from './ip-network';

describe('admin IP allowlist', () => {
  it('accepts empty, exact-IP, and CIDR entries for IPv4 and IPv6', () => {
    expect(isValidAdminIpAllowlist('')).toBe(true);
    expect(isValidAdminIpAllowlist('192.0.2.10, 2001:db8::/32')).toBe(true);
    expect(isValidAdminIpAllowlist('192.0.2.0/33')).toBe(false);
    expect(isValidAdminIpAllowlist('2001:db8::/129')).toBe(false);
    expect(isValidAdminIpAllowlist('192.0.2.1,')).toBe(false);
  });

  it('matches exact and subnet addresses without accepting other networks', () => {
    expect(isAdminIpAllowed('', '203.0.113.8')).toBe(true);
    expect(isAdminIpAllowed('192.0.2.0/24', '192.0.2.42')).toBe(true);
    expect(isAdminIpAllowed('192.0.2.0/24', '192.0.3.42')).toBe(false);
    expect(isAdminIpAllowed('2001:db8:1::/48', '2001:db8:1:2::7')).toBe(true);
    expect(isAdminIpAllowed('127.0.0.1', '::ffff:127.0.0.1')).toBe(true);
  });
});
