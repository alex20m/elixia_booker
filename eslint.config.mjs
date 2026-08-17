import nextConfig from 'eslint-config-next/core-web-vitals';
import typescriptConfig from 'eslint-config-next/typescript';

/**
 * ESLint, invoked directly rather than through `next lint`.
 *
 * Next 16 removed that wrapper, which is why `npm run lint` used to fail with
 * "no such directory: lint" — the argument it had always been given was being
 * read as a path. Nothing else was wrong; the config it would have generated
 * simply now has to live here.
 *
 * `core-web-vitals` brings the base Next rules with it, and the TypeScript
 * config adds typescript-eslint's recommended set plus the ignores for build
 * output.
 */
const config = [
  ...nextConfig,
  ...typescriptConfig,
  {
    // Redacted Playwright captures: recorded data, not source.
    ignores: ['captures/**'],
  },
  {
    rules: {
      // A leading underscore is how this codebase marks a parameter it must
      // accept but deliberately does not use — the unimplemented Elixia adapter
      // is full of them, and they document the signature it has to satisfy.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];

export default config;
