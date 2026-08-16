import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Mirrors the "@/*" path alias from tsconfig so tests import the same way
    // the app does.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: { environment: 'node' },
});
