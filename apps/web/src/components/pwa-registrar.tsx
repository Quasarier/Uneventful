'use client';

import { useEffect } from 'react';

export function PwaRegistrar() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // The app remains usable when service workers are disabled by browser policy.
      });
    }
  }, []);

  return null;
}
