'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import type { components } from '@/lib/api-schema';

type Preference = components['schemas']['NotificationPreference'];
type PreferencesResponse = components['schemas']['NotificationPreferences'];

function decodeVapidKey(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Push notifications are not configured for this application.');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return new Uint8Array(decoded.split('').map((character) => character.charCodeAt(0))).buffer;
}

function readableType(value: string): string {
  return value
    .replace(/^EVENT_REMINDER_/, 'Event reminder ')
    .replace(/^EVENT_/, 'Event ')
    .replace(/^RSVP_/, 'RSVP ')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

export function NotificationSettings() {
  const { accessToken, getValidAccessToken } = useAuth();
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [subscriptionCount, setSubscriptionCount] = useState(0);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const loadPreferences = useCallback(async () => {
    const token = await getValidAccessToken();
    if (!token) {
      throw new Error('Your session has expired. Sign in again to continue.');
    }
    const {
      data,
      error: responseError,
      response,
    } = await createApiClient(token).GET('/me/notification-preferences');
    if (!response.ok || !data) {
      throw new Error(errorMessage(responseError, 'Notification settings could not be loaded.'));
    }
    const responseData = data as PreferencesResponse;
    setPreferences(responseData.data.preferences);
    setSubscriptionCount(responseData.data.pushSubscriptionCount);
    setVapidPublicKey(responseData.data.vapidPublicKey);
  }, [getValidAccessToken]);

  useEffect(() => {
    let active = true;
    void loadPreferences()
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : 'Notification settings could not be loaded.',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accessToken, loadPreferences]);

  async function updatePreference(preference: Preference, enabled: boolean) {
    const key = `${preference.channel}:${preference.type}`;
    setSavingKey(key);
    setError('');
    setStatus('');
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('Your session has expired. Sign in again to continue.');
      const { error: responseError, response } = await createApiClient(token).PATCH(
        '/me/notification-preferences',
        {
          body: { preferences: [{ channel: preference.channel, type: preference.type, enabled }] },
        },
      );
      if (!response.ok) {
        throw new Error(errorMessage(responseError, 'The preference could not be saved.'));
      }
      setPreferences((current) =>
        current.map((item) =>
          item.channel === preference.channel && item.type === preference.type
            ? { ...item, enabled }
            : item,
        ),
      );
      setStatus('Notification preference saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The preference could not be saved.');
    } finally {
      setSavingKey('');
    }
  }

  async function enablePush() {
    setError('');
    setStatus('');
    try {
      if (
        !('Notification' in window) ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window)
      ) {
        throw new Error('Push notifications are not supported in this browser.');
      }
      if (!vapidPublicKey) {
        throw new Error('Push notifications are not configured for this application.');
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus('Browser notification permission was not granted.');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(vapidPublicKey),
      });
      const serialized = subscription.toJSON();
      const p256dh = serialized.keys?.p256dh;
      const auth = serialized.keys?.auth;
      if (!subscription.endpoint || !p256dh || !auth) {
        throw new Error('The browser returned an incomplete push subscription.');
      }
      const token = await getValidAccessToken();
      if (!token) throw new Error('Your session has expired. Sign in again to continue.');
      const { error: responseError, response } = await createApiClient(token).POST(
        '/me/push-subscriptions',
        { body: { endpoint: subscription.endpoint, keys: { p256dh, auth } } },
      );
      if (!response.ok) {
        throw new Error(errorMessage(responseError, 'Push notifications could not be enabled.'));
      }
      await loadPreferences();
      setStatus('Push notifications are enabled for this device.');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Push notifications could not be enabled.',
      );
    }
  }

  async function disablePush() {
    setError('');
    setStatus('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setStatus('This device has no active push subscription.');
        return;
      }
      const token = await getValidAccessToken();
      if (!token) throw new Error('Your session has expired. Sign in again to continue.');
      const { error: responseError, response } = await createApiClient(token).DELETE(
        '/me/push-subscriptions',
        { body: { endpoint: subscription.endpoint } },
      );
      if (!response.ok) {
        throw new Error(errorMessage(responseError, 'Push notifications could not be disabled.'));
      }
      await subscription.unsubscribe();
      await loadPreferences();
      setStatus('Push notifications were disabled for this device.');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Push notifications could not be disabled.',
      );
    }
  }

  if (loading) {
    return (
      <p aria-live="polite" className="py-8 font-semibold text-forest" role="status">
        Loading notification settings…
      </p>
    );
  }

  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-8">
        <p className="eyebrow">Stay in the loop</p>
        <h1 className="font-display mt-3 text-4xl font-black tracking-tight sm:text-5xl">
          Notifications
        </h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm leading-6 text-ink/75">
        Email notifications are on by default. Push notifications are off until you enable them.
        RSVP and event cancellation emails can be disabled here; your choice is recorded.
      </p>
      <div className="mb-8 rounded-3xl border border-forest/10 bg-white p-6 shadow-card">
        <h2 className="font-display text-xl font-bold">This device</h2>
        <p className="mt-2 text-sm text-ink/75">
          {subscriptionCount} push subscription{subscriptionCount === 1 ? '' : 's'} on your account.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className="rounded-full bg-forest px-5 py-3 text-sm font-bold text-white focus-visible:outline"
            onClick={() => void enablePush()}
            type="button"
          >
            Enable push on this device
          </button>
          <button
            className="rounded-full border border-forest/20 px-5 py-3 text-sm font-bold text-forest focus-visible:outline"
            onClick={() => void disablePush()}
            type="button"
          >
            Disable push on this device
          </button>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {(['EMAIL', 'PUSH'] as const).map((channel) => (
          <section
            aria-labelledby={`notification-${channel.toLowerCase()}-heading`}
            className="rounded-3xl border border-forest/10 bg-white p-6 shadow-card"
            key={channel}
          >
            <h2
              className="font-display text-xl font-bold"
              id={`notification-${channel.toLowerCase()}-heading`}
            >
              {channel === 'EMAIL' ? 'Email' : 'Push'}
            </h2>
            <ul className="mt-4 space-y-3">
              {preferences
                .filter((preference) => preference.channel === channel)
                .map((preference) => {
                  const key = `${preference.channel}:${preference.type}`;
                  return (
                    <li key={key}>
                      <label className="flex items-start gap-3 text-sm">
                        <input
                          checked={preference.enabled}
                          className="mt-1 size-4 accent-forest"
                          disabled={savingKey === key}
                          onChange={(event) =>
                            void updatePreference(preference, event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        <span>{readableType(preference.type)}</span>
                      </label>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      </div>
      {status && (
        <p aria-live="polite" className="mt-5 text-sm font-semibold text-forest" role="status">
          {status}
        </p>
      )}
      {error && (
        <p aria-live="assertive" className="mt-5 text-sm text-coral" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
