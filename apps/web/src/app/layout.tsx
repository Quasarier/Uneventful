import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/components/auth-provider';
import { PwaRegistrar } from '@/components/pwa-registrar';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: {
    default: 'Uneventful',
    template: '%s | Uneventful',
  },
  description: 'Find and join events across campus.',
  applicationName: 'Uneventful',
  manifest: '/manifest.json',
  icons: [{ rel: 'icon', url: '/icons/icon.svg', type: 'image/svg+xml' }],
};

export const viewport: Viewport = {
  themeColor: '#123d35',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <PwaRegistrar />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
