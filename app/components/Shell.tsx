'use client';

import { Brand } from './Brand';

/**
 * The frame every screen sits in: a sticky bar carrying the logo and whatever
 * the screen puts beside it. The theme control lives in Settings only, not
 * here — this bar is for the actions a visitor reaches for on every screen.
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
          <div className="appbar-actions">{actions}</div>
        </div>
      </header>
      {children}
    </div>
  );
}
