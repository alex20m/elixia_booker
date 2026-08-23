'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, which is what makes the app installable and
 * gives it something to say when the network is gone.
 *
 * Production only, deliberately. In development the dev server rebuilds assets
 * under the same paths the worker treats as immutable, so a registered worker
 * there serves the previous build's chunks and every change appears not to
 * work — a confusing failure whose cause is nowhere near its symptom.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    // Registration failing is not worth a message: the app works without it,
    // and the only visible loss is the install offer on some browsers.
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);

  return null;
}
