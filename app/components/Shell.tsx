'use client';

import { Brand } from './Brand';
import { ThemeToggle } from './theme';

/**
 * The frame every screen sits in: a sticky bar carrying the logo and whatever
 * the screen puts beside it, and the theme control — which is reachable from
 * everywhere, including the pages a signed-out visitor sees.
 */
export function Shell({
  actions,
  children,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="shell">
      <header className="appbar">
        <div className="appbar-inner">
          <Brand />
          <div className="appbar-actions">
            {actions}
            <ThemeToggle />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
