'use client';

import { useRouter } from 'next/navigation';

/**
 * Returns to wherever the visitor actually came from, rather than always the
 * app's root. `/account/*` is reachable from the Settings tab, which keeps
 * its own place in the URL (see `Dashboard` in app/DashboardApp.tsx) — going
 * back through browser history lands there again instead of resetting to the
 * first tab.
 *
 * Falls back to a plain navigation home when there is no history to step
 * back through — e.g. the page was opened directly rather than reached by
 * clicking through the app.
 */
export function BackButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm"
      onClick={() => {
        if (typeof window !== 'undefined' && window.history.length > 1) {
          router.back();
        } else {
          router.push('/');
        }
      }}
    >
      Back
    </button>
  );
}
