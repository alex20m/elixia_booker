import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the "@/*" path alias from tsconfig so tests import the same
      // way the app does.
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // Next has no "exports" map, so bare `next/headers` / `next/server`
      // resolve fine inside Next's own bundler (which probes extensions) but
      // not under Vite's SSR resolution, which defers to Node's stricter ESM
      // loader for externalized deps. @neondatabase/auth imports both without
      // an extension; point them at the real files so tests can load it.
      'next/headers': 'next/headers.js',
      'next/server': 'next/server.js',
    },
  },
  test: {
    environment: 'node',
    // Forces Vite to process @neondatabase/auth's own source rather than
    // externalizing it straight to Node's loader, so the next/headers and
    // next/server aliases above actually get applied.
    server: { deps: { inline: [/@neondatabase\/auth/] } },
  },
});
