'use client';

import { useEffect, useState } from 'react';
import { WEB_ORIGIN } from '@/lib/auth-config';

export default function AuthPopupPage() {
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const opener = window.opener;
    if (!opener || opener.closed) {
      setComplete(false);
      return;
    }

    const status = new URLSearchParams(window.location.search).get('status');
    opener.postMessage(
      {
        type: 'uneventful:auth',
        success: status === 'success',
      },
      WEB_ORIGIN,
    );
    setComplete(true);
    window.close();
  }, []);

  return (
    <main>
      <h1>{complete ? 'Sign-in complete' : 'Return to the sign-in window'}</h1>
      <p>{complete ? 'You may close this window.' : 'No sign-in window was found.'}</p>
    </main>
  );
}
