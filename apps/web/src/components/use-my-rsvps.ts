'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createApiClient, errorMessage } from '@/lib/api-client';
import type { MyRsvp } from '@/lib/event-format';

export function useMyRsvps() {
  const { accessToken } = useAuth();
  const [rsvps, setRsvps] = useState<MyRsvp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError('Your session has expired. Sign in again to continue.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const {
        data,
        error: responseError,
        response,
      } = await createApiClient(accessToken).GET('/rsvps/me');
      if (!data) {
        setError(errorMessage(responseError, 'Your RSVPs could not be loaded.'));
        setRsvps([]);
        return;
      }
      if (!response.ok) {
        setError('Your RSVPs could not be loaded.');
        setRsvps([]);
        return;
      }
      setRsvps(data.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your RSVPs could not be loaded.');
      setRsvps([]);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rsvps, loading, error, reload };
}
