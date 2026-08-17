import type { Metadata, Viewport } from 'next';
import { StackProvider, StackTheme } from '@stackframe/stack';
import { stackServerApp } from '@/lib/auth/stack';
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
  const auth = stackServerApp();

  return (
    <html lang="en">
      <body>
        {/* Without Neon Auth configured there is no app to provide, so the page
            renders bare and explains what to set rather than crashing on a
            constructor that cannot find its keys. */}
        {auth ? (
          <StackProvider app={auth}>
            <StackTheme>
              <div className="wrap">{children}</div>
            </StackTheme>
          </StackProvider>
        ) : (
          <div className="wrap">{children}</div>
        )}
      </body>
    </html>
  );
}
