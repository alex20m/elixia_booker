import type { Metadata, Viewport } from 'next';
import '@neondatabase/auth-ui/css';
import { authConfigured } from '@/lib/auth/neonAuth';
import { INSTALL_PROMPT_SCRIPT } from '@/lib/pwa';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import { ServiceWorkerRegistration } from './components/ServiceWorkerRegistration';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Elixia Booker',
  description: 'Books your group fitness classes the moment booking opens.',
  applicationName: 'Elixia Booker',
  manifest: '/manifest.webmanifest',
  // What iOS uses when the app is added to a home screen. It reads none of the
  // manifest for this; without these it launches in a browser view with a
  // title bar, which is the difference between "an app" and "a bookmark".
  appleWebApp: { capable: true, title: 'Booker', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets the layout reach under a notch, which the safe-area insets in the
  // stylesheet then pad back out where it matters.
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d0e' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* suppressHydrationWarning covers this one element, not its subtree: the
       theme script below stamps class="light"/"dark" and a color-scheme onto
       <html> before React hydrates, and the server markup can never carry
       them. Mismatches anywhere inside the page are still reported. */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Both of these have to run before anything else, and neither can be a
            module: one paints the theme before the first frame, the other
            catches an install prompt that fires long before React mounts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: INSTALL_PROMPT_SCRIPT }} />
      </head>
      <body>
        <ServiceWorkerRegistration />
        {/* Without Neon Auth configured there is no app to provide, so the page
            renders bare and explains what to set rather than crashing on a
            constructor that cannot find its keys. */}
        {authConfigured() ? <Providers>{children}</Providers> : children}
      </body>
    </html>
  );
}
