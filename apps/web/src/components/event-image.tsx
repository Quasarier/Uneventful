'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { API_BASE_URL } from '@/lib/auth-config';

interface EventImageProps {
  accessToken: string | null;
  alt: string;
  eventId: string;
}

const allowedContentTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function EventImage({ accessToken, alt, eventId }: EventImageProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setImageUrl(null);
    setFailed(false);
    if (!accessToken) {
      return;
    }

    const controller = new AbortController();
    let active = true;
    let objectUrl: string | undefined;

    async function loadImage() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/events/${encodeURIComponent(eventId)}/image`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error('The event image could not be loaded.');
        }

        const contentType = response.headers.get('content-type')?.split(';', 1)[0];
        if (!contentType || !allowedContentTypes.has(contentType)) {
          throw new Error('The event image has an unsupported content type.');
        }

        const blob = await response.blob();
        if (!active) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === 'AbortError')) {
          setFailed(true);
        }
      }
    }

    void loadImage();

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [accessToken, eventId]);

  return (
    <div className="relative mt-6 aspect-[16/9] overflow-hidden rounded-3xl bg-paper">
      {imageUrl ? (
        <Image
          alt={alt}
          className="object-cover"
          fill
          priority
          sizes="(max-width: 768px) 100vw, 896px"
          src={imageUrl}
          unoptimized
        />
      ) : failed ? (
        <p className="flex h-full items-center justify-center p-6 text-sm text-coral" role="alert">
          The event image could not be loaded.
        </p>
      ) : (
        <p
          aria-live="polite"
          className="flex h-full items-center justify-center p-6 text-sm"
          role="status"
        >
          Loading event image…
        </p>
      )}
    </div>
  );
}
