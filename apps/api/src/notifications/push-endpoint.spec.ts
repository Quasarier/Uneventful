import { describe, expect, it, vi } from 'vitest';
import {
  isPublicIpAddress,
  isSafePushEndpoint,
  PushEndpointResolutionError,
} from './push-endpoint';

describe('push endpoint SSRF checks', () => {
  it('accepts HTTPS endpoints only when every resolved address is globally routable', async () => {
    const resolvePublicHost = vi.fn(async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);

    await expect(
      isSafePushEndpoint('https://push.example.edu/subscription', resolvePublicHost),
    ).resolves.toBe(true);
    expect(resolvePublicHost).toHaveBeenCalledWith('push.example.edu');
  });

  it('rejects private, loopback, link-local, reserved, and non-HTTPS targets', async () => {
    const resolvePrivateHost = vi.fn(async () => [{ address: '10.4.0.12', family: 4 }]);

    await expect(isSafePushEndpoint('http://push.example.edu', resolvePrivateHost)).resolves.toBe(
      false,
    );
    await expect(isSafePushEndpoint('https://localhost', resolvePrivateHost)).resolves.toBe(false);
    await expect(isSafePushEndpoint('https://127.0.0.1', resolvePrivateHost)).resolves.toBe(false);
    await expect(isSafePushEndpoint('https://push.example.edu', resolvePrivateHost)).resolves.toBe(
      false,
    );
    expect(isPublicIpAddress('169.254.10.2')).toBe(false);
    expect(isPublicIpAddress('192.168.1.1')).toBe(false);
    expect(isPublicIpAddress('::1')).toBe(false);
  });

  it('rejects mixed DNS answers and reports DNS failures without accepting the endpoint', async () => {
    await expect(
      isSafePushEndpoint('https://mixed.example.edu', async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '192.168.1.2', family: 4 },
      ]),
    ).resolves.toBe(false);
    await expect(
      isSafePushEndpoint('https://unresolved.example.edu', async () => {
        throw new Error('DNS unavailable');
      }),
    ).rejects.toBeInstanceOf(PushEndpointResolutionError);
  });
});
