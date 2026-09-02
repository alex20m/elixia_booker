import { test, expect, type Page } from '@playwright/test';
import { TEST_USER } from './fixtures/testUser';

/**
 * Drives the real sign-in form in a real browser, against the real app and
 * its real auth proxy — with tests-e2e/fixtures/fakeNeonAuth.ts standing in
 * for the managed Neon Auth service so the upstream failure PR #107 fixed can
 * be scripted on demand instead of waited for.
 *
 * The third test is the regression test for that fix. The other three exist
 * so it can't pass by accident: a correct sign-in still works with no
 * failures in the mix, a wrong password still fails, and a sustained outage
 * still fails rather than hanging or silently retrying forever — a retry
 * that quietly turned every login into a success, or one that never gave up,
 * would each pass the regression test for the wrong reason.
 */

const FAKE_AUTH_URL = process.env.FAKE_NEON_AUTH_URL ?? 'http://localhost:4411';

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE_AUTH_URL}/__test__/reset`);
});

async function armGetSessionFailures(request: import('@playwright/test').APIRequestContext, count: number) {
  await request.post(`${FAKE_AUTH_URL}/__test__/arm-get-session-failures`, { data: { count } });
}

async function setGetSessionOutage(request: import('@playwright/test').APIRequestContext, down: boolean) {
  await request.post(`${FAKE_AUTH_URL}/__test__/set-get-session-outage`, { data: { down } });
}

/**
 * Loads the sign-in page and waits for it to settle.
 *
 * The page checks its own session on mount — before any credentials are
 * typed — which is a `GET /get-session` call same as any other. Split out so
 * a test that arms scripted failures can arm them *after* this one has
 * already landed, or that call would eat one of the failures meant for the
 * sign-in itself and under-count what the fix actually has to survive.
 */
async function openSignInPage(page: Page) {
  await page.goto('/auth/sign-in');
  await page.waitForLoadState('networkidle');
}

async function submitCredentials(page: Page, email: string, password: string) {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

/**
 * Reached only once the visitor is genuinely signed in: `#load-error` is
 * `DashboardApp`'s "could not load your account" banner, which only renders
 * once `dashboardScreen()` has resolved `signedIn: true` — this e2e run sets
 * no `ENCRYPTION_KEY`, so a real sign-in always ends up here, deterministically.
 * A weaker check (just "not on the sign-in page") would also pass while stuck
 * on the loading screen or bounced to the signed-out landing page, so it
 * can't tell a real sign-in from one of those.
 */
async function expectSignedIn(page: Page) {
  await expect(page.locator('#load-error')).toBeVisible({ timeout: 10_000 });
}

/** `DashboardApp`'s signed-out landing page — reached once `useSession()` has settled on no user. */
async function expectSignedOut(page: Page) {
  await expect(page.locator('#auth-btn')).toBeVisible({ timeout: 10_000 });
}

test('signs in with the correct email and password', async ({ page }) => {
  await openSignInPage(page);
  await submitCredentials(page, TEST_USER.email, TEST_USER.password);

  await expectSignedIn(page);
});

test('shows an error and leaves a wrong password on the sign-in page', async ({ page }) => {
  await openSignInPage(page);
  await submitCredentials(page, TEST_USER.email, 'not-the-password');

  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expect(page.locator('input[name="email"]')).toBeVisible();
});

/**
 * The regression test for PR #107.
 *
 * A fresh sign-in checks its own new session from more than one place —
 * inside the proxy itself, right after the client's post-sign-in refetch,
 * and again from the destination page's own session hook once it mounts —
 * so a single scripted failure was never enough to reproduce the bug: the
 * app already had more than one chance to get an unbroken answer before
 * PR #107. Five is the smallest number of consecutive failures that reliably
 * exhausts all of them against this build (verified directly: reverting the
 * fix makes this test fail on every run at this count, and it stays reliably
 * green with the fix in place) — a magic number in the sense that it is
 * tied to today's call graph rather than derived from it, so if this ever
 * starts flaking, that call graph has probably changed and the count needs
 * re-checking, not raising blindly.
 */
test('still signs in when the session check blips five times right after a correct password', async ({
  page,
  request,
}) => {
  await openSignInPage(page);
  await armGetSessionFailures(request, 5);

  await submitCredentials(page, TEST_USER.email, TEST_USER.password);

  await expectSignedIn(page);
});

/**
 * The retry is bounded, on purpose — it absorbs a blip, not a sustained
 * outage. A get-session check that fails every single time (rather than a
 * fixed, countable number of times, which the app's more-than-one caller
 * makes an unreliable way to prove "never recovers" — see the comment
 * above) should still surface as a failure rather than hang or silently
 * retry forever.
 */
test('still shows signed-out when the session check never recovers', async ({ page, request }) => {
  await openSignInPage(page);
  await setGetSessionOutage(request, true);

  await submitCredentials(page, TEST_USER.email, TEST_USER.password);

  // The password was correct, so this isn't the sign-in form's own "wrong
  // password" error — the session check itself just never comes back with an
  // answer. The visitor should not be left looking silently signed in.
  await expectSignedOut(page);
});
