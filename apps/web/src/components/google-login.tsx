'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL, WEB_ORIGIN } from '@/lib/auth-config';

interface ApiSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

interface AuthPopupMessage {
  type: 'uneventful:auth';
  success: boolean;
}

type LoginState = 'signed-out' | 'waiting' | 'loading' | 'signed-in' | 'error';

export function GoogleLogin() {
  const popupRef = useRef<WindowProxy | null>(null);
  const messageHandledRef = useRef(false);
  const [state, setState] = useState<LoginState>('signed-out');
  const [session, setSession] = useState<ApiSession | null>(null);

  const receivePopupMessage = useCallback(async (event: MessageEvent<unknown>) => {
    const popup = popupRef.current;
    if (
      !popup ||
      event.origin !== WEB_ORIGIN ||
      event.source !== popup ||
      !isAuthPopupMessage(event.data) ||
      messageHandledRef.current
    ) {
      return;
    }

    messageHandledRef.current = true;
    popupRef.current = null;
    popup.close();

    if (!event.data.success) {
      setState('error');
      return;
    }

    setState('loading');
    try {
      const newSession = await fetchSession();
      setSession(newSession);
      setState('signed-in');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', receivePopupMessage);
    return () => {
      window.removeEventListener('message', receivePopupMessage);
      popupRef.current?.close();
      popupRef.current = null;
    };
  }, [receivePopupMessage]);

  const startLogin = () => {
    messageHandledRef.current = false;
    const popup = window.open(
      `${API_BASE_URL}/auth/google`,
      'uneventful-google-login',
      'popup,width=520,height=680',
    );
    if (!popup) {
      setState('error');
      return;
    }

    popupRef.current = popup;
    setSession(null);
    setState('waiting');
  };

  return (
    <section aria-label="Google sign-in">
      <button onClick={startLogin} type="button">
        Continue with Google
      </button>
      <p aria-live="polite" role="status">
        {state === 'signed-out' && 'Not signed in.'}
        {state === 'waiting' && 'Waiting for Google sign-in.'}
        {state === 'loading' && 'Loading your session.'}
        {state === 'signed-in' && session && 'Signed in.'}
        {state === 'error' && 'Sign-in failed. Please try again.'}
      </p>
    </section>
  );
}

async function fetchSession(): Promise<ApiSession> {
  const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'X-Uneventful-CSRF': '1',
    },
  });
  if (!response.ok) {
    throw new Error('Session could not be loaded.');
  }

  const body: unknown = await response.json();
  if (!isApiSession(body)) {
    throw new Error('Session response was invalid.');
  }
  return body;
}

function isApiSession(value: unknown): value is ApiSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    candidate.tokenType === 'Bearer' &&
    typeof candidate.expiresIn === 'number' &&
    Number.isInteger(candidate.expiresIn) &&
    candidate.expiresIn > 0
  );
}

function isAuthPopupMessage(value: unknown): value is AuthPopupMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    candidate.type === 'uneventful:auth' &&
    typeof candidate.success === 'boolean'
  );
}
