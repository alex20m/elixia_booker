import type { Metadata, Viewport } from 'next';
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
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
