'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { API_BASE_URL } from '@/lib/auth-config';
import { clearAllCheckinData } from '@/lib/checkin-storage';
import type { components } from '@/lib/api-schema';

interface ApiSession {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

type UserRole = components['schemas']['UserProfile']['role'];

interface AuthContextValue {
  accessToken: string | null;
  userRole: UserRole | null;
  acceptSession: (session: ApiSession) => void;
  clearSession: () => void;
  ensureSession: () => Promise<boolean>;
  getValidAccessToken: () => Promise<string | null>;
  logout: () => Promise<void>;
  setUserRole: (role: UserRole | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_CHANNEL_NAME = 'uneventful-auth';

async function clearApplicationCaches(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  await clearAllCheckinData();
  if (!('caches' in window)) {
    return;
  }
  const cacheNames = await window.caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith('uneventful-'))
      .map((name) => window.caches.delete(name)),
  );
  window.navigator.serviceWorker?.controller?.postMessage({ type: 'uneventful:logout' });
}

function isLogoutMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'logout';
}

export function AuthProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const accessTokenRef = useRef<string | null>(null);
  const expiresAtRef = useRef(0);
  const refreshPromiseRef = useRef<Promise<boolean> | null>(null);
  const logoutChannelRef = useRef<BroadcastChannel | null>(null);

  const acceptSession = useCallback((session: ApiSession) => {
    const nextExpiry = Date.now() + session.expiresIn * 1000;
    accessTokenRef.current = session.accessToken;
    expiresAtRef.current = nextExpiry;
    setAccessToken(session.accessToken);
    setExpiresAt(nextExpiry);
  }, []);

  const clearSession = useCallback(() => {
    void clearAllCheckinData().catch(() => {
      console.error('Unable to clear offline check-in data after session termination.');
    });
    accessTokenRef.current = null;
    expiresAtRef.current = 0;
    setAccessToken(null);
    setExpiresAt(0);
    setUserRole(null);
  }, []);

  const ensureSession = useCallback((): Promise<boolean> => {
    if (accessTokenRef.current && expiresAtRef.current > Date.now() + 30_000) {
      return Promise.resolve(true);
    }
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const refreshSession = async (): Promise<boolean> => {
      try {
        const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'X-Uneventful-CSRF': '1' },
        });
        if (!response.ok) {
          clearSession();
          return false;
        }
        const body: unknown = await response.json();
        if (!isApiSession(body)) {
          clearSession();
          throw new Error('Session response was invalid.');
        }
        acceptSession(body);
        return true;
      } finally {
        refreshPromiseRef.current = null;
      }
    };
    const refresh = (async () => {
      if (typeof navigator === 'undefined' || !navigator.locks) {
        return refreshSession();
      }
      return await navigator.locks.request('uneventful-auth-refresh', refreshSession);
    })();

    refreshPromiseRef.current = refresh;
    return refresh;
  }, [acceptSession, clearSession]);

  const getValidAccessToken = useCallback(async (): Promise<string | null> => {
    const isAuthenticated = await ensureSession();
    return isAuthenticated ? accessTokenRef.current : null;
  }, [ensureSession]);

  const logout = useCallback(async () => {
    const response = await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'X-Uneventful-CSRF': '1' },
    });
    if (!response.ok) {
      throw new Error('Sign-out could not be completed. Please try again.');
    }
    clearSession();
    try {
      await clearApplicationCaches();
    } finally {
      logoutChannelRef.current?.postMessage({ type: 'logout' });
    }
  }, [clearSession]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') {
      return;
    }

    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    logoutChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isLogoutMessage(event.data)) {
        clearSession();
        void clearApplicationCaches().catch(() => {
          console.error('Unable to clear application caches after sign-out in another tab.');
        });
      }
    };

    return () => {
      channel.close();
      if (logoutChannelRef.current === channel) {
        logoutChannelRef.current = null;
      }
    };
  }, [clearSession]);

  useEffect(() => {
    if (!accessToken || expiresAt === 0) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        void ensureSession().catch(() => clearSession());
      },
      Math.max(0, expiresAt - Date.now() - 60_000),
    );
    return () => window.clearTimeout(timer);
  }, [accessToken, expiresAt, ensureSession, clearSession]);

  const value = useMemo(
    () => ({
      accessToken,
      userRole,
      acceptSession,
      clearSession,
      ensureSession,
      getValidAccessToken,
      logout,
      setUserRole,
    }),
    [
      accessToken,
      userRole,
      acceptSession,
      clearSession,
      ensureSession,
      getValidAccessToken,
      logout,
      setUserRole,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return context;
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
