import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests that drive the real sign-in UI in a real browser, against
 * the real app.
 *
 * The vitest suite in tests/ proves the auth proxy's own logic by mocking the
 * handler directly (see tests/authRoute.test.ts) — fast, but it never renders
 * a page, so it cannot catch a bug that only exists in what the browser does
 * with the response: a toast nobody sees, a form that clears without
 * navigating, a retry that fixes the network call but not the screen. This
 * suite is for exactly that gap, at the cost of being slower and needing a
 * browser and two servers to run.
 *
 * Nothing here talks to the real, managed Neon Auth service or needs any
 * secret from it: `tests-e2e/fixtures/fakeNeonAuth.ts` stands in for it, and
 * exists specifically so a test can script an upstream failure on demand —
 * the one thing a real dependency can't be asked to do to order — rather than
 * waiting for one to happen on its own.
 */
const FAKE_AUTH_PORT = 4411;
const APP_PORT = 4400;
const FAKE_AUTH_URL = `http://localhost:${FAKE_AUTH_PORT}`;
const BASE_URL = `http://localhost:${APP_PORT}`;

export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Set only in environments (this sandbox included) that pre-cache a
    // Chromium build outside Playwright's own managed browser directory —
    // see the environment notes for why `playwright install` isn't run here.
    // CI installs browsers normally, so this stays unset there.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx tests-e2e/fixtures/fakeNeonAuth.ts',
      url: FAKE_AUTH_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      env: { FAKE_NEON_AUTH_PORT: String(FAKE_AUTH_PORT) },
    },
    {
      // A production build, not `next dev`: dev mode double-invokes effects
      // (React's Strict Mode double-render, meant to surface side-effect
      // bugs), which double-fires the session check these tests are counting
      // and makes the exact number of upstream calls per run nondeterministic
      // — the retry tests below flaked under `next dev` for exactly that
      // reason. A production build is also what the retry actually has to
      // hold up under.
      command: `npx next build && npx next start -p ${APP_PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        // Points the real app's auth proxy (app/api/auth/[...path]/route.ts)
        // at the fake server above instead of the real managed instance.
        NEON_AUTH_BASE_URL: FAKE_AUTH_URL,
        NEON_AUTH_COOKIE_SECRET: 'e2e-test-cookie-secret-do-not-use-elsewhere',
      },
    },
  ],
});
