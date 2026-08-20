import type { Metadata, Viewport } from 'next';
import '@neondatabase/auth-ui/css';
import { authConfigured } from '@/lib/auth/neonAuth';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Elixia Booker',
  description: 'Books your group fitness classes the moment booking opens.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Follows the visitor's OS setting; the stylesheet defines both palettes.
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Without Neon Auth configured there is no app to provide, so the page
            renders bare and explains what to set rather than crashing on a
            constructor that cannot find its keys. */}
        {authConfigured() ? (
          <Providers>
            <div className="wrap">{children}</div>
          </Providers>
        ) : (
          <div className="wrap">{children}</div>
        )}
      </body>
    </html>
  );
}
