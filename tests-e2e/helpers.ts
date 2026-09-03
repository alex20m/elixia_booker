import { expect, type Page } from '@playwright/test';
import { TEST_USER } from './fixtures/testUser';

/**
 * Shared driving code for every e2e spec, so each one reads as the flow it is
 * testing rather than repeating how to reach the sign-in form or recognise a
 * signed-in visitor. Split out once a second spec file (tests-e2e/dashboard.spec.ts)
 * needed the same sign-in dance as tests-e2e/login.spec.ts.
 */

/**
 * Loads the sign-in page and waits for it to settle.
 *
 * The page checks its own session on mount — before any credentials are
 * typed — which is a `GET /get-session` call same as any other. Split out so
 * a test that arms scripted failures can arm them *after* this one has
 * already landed, or that call would eat one of the failures meant for the
 * sign-in itself and under-count what the fix actually has to survive.
 */
export async function openSignInPage(page: Page): Promise<void> {
  await page.goto('/auth/sign-in');
  await page.waitForLoadState('networkidle');
}

export async function submitCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

/**
 * Reached once the visitor is genuinely signed in — during initial setup, or
 * on the dashboard proper, once it has finished. Both render inside the same
 * `<Shell>` as the signed-out landing page (see app/components/Shell.tsx), so
 * shell markup alone cannot tell a real sign-in apart from being signed out.
 * `Setup`'s own heading and the dashboard's own section nav are each unique
 * to their own screen and mutually exclusive, so exactly one of them is on
 * screen the instant a real sign-in resolves — whichever it is, is a
 * `DashboardApp` that has resolved `signedIn: true`, which is what matters
 * here.
 *
 * `#nav-classes` rather than `NavMenu`'s mobile `#menu-btn`: both exist in
 * the DOM at once (see the comment on `NavMenu`), and only one is ever
 * actually visible depending on viewport width — this suite's `chromium`
 * project runs at the Desktop Chrome preset's width, well past the 46rem
 * breakpoint where the inline nav (`#nav-classes` among it) is the one CSS
 * shows and `#menu-btn` is `display: none`, so asserting visibility on the
 * latter here would just time out.
 */
export async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.locator('h1:has-text("Set up your booker"), #nav-classes')).toBeVisible({
    timeout: 10_000,
  });
}

/** `DashboardApp`'s signed-out landing page — reached once `useSession()` has settled on no user. */
export async function expectSignedOut(page: Page): Promise<void> {
  await expect(page.locator('#auth-btn')).toBeVisible({ timeout: 10_000 });
}

/**
 * The localStorage key `InstallPopup` (app/components/InstallPopup.tsx) reads
 * to decide it has been told never to open again — see
 * `INSTALL_POPUP_DISMISSED_KEY` in lib/pwa.ts, which this mirrors rather than
 * imports: Playwright's `addInitScript` below runs the callback as a browser
 * script, serialised independently of this file's own module graph.
 */
const INSTALL_POPUP_DISMISSED_KEY = 'elixia-install-popup-dismissed';

/** Signs in as the one account tests-e2e/fixtures/fakeNeonAuth.ts recognizes. */
export async function signIn(
  page: Page,
  email: string = TEST_USER.email,
  password: string = TEST_USER.password,
): Promise<void> {
  // Pre-empts InstallPopup rather than dismissing it once it appears: the
  // popup only opens once `useInstallability`'s `useSyncExternalStore`
  // resolves past its initial `''` snapshot, which takes an extra render or
  // two after the dashboard mounts — a race no fixed wait after the fact can
  // reliably win, since how long it takes depends on what else is rendering
  // at the time. `addInitScript` runs before any of this app's own script
  // does, on every navigation this page makes from here on (including a
  // later `page.reload()`), so the popup reads itself as already dismissed
  // from its very first render and never opens in the first place.
  await page.addInitScript((key: string) => {
    window.localStorage.setItem(key, '1');
  }, INSTALL_POPUP_DISMISSED_KEY);

  await openSignInPage(page);
  await submitCredentials(page, email, password);
  await expectSignedIn(page);
}

/**
 * Elixia credentials the mock backend (lib/mock.ts, `MOCK_ELIXIA=1`) accepts:
 * any address with an "@" and any password four characters or longer.
 */
export const MOCK_ELIXIA_CREDENTIALS = { email: 'e2e-elixia@example.com', password: 'mock-pass-1234' };

/**
 * Walks a freshly signed-in account through the setup wizard with fixed,
 * valid answers, or does nothing if setup is already finished.
 *
 * This is idempotent on purpose rather than assuming it runs first: the app
 * webServer this suite drives is one process shared by every spec in the run
 * (see playwright.config.ts), so TEST_USER's account — and whether it has
 * already been configured — persists across spec files. Any test that needs
 * the dashboard calls this first instead of assuming a particular run order.
 */
export async function completeSetupIfNeeded(page: Page): Promise<void> {
  const heading = page.locator('h1:has-text("Set up your booker")');
  if (!(await heading.isVisible().catch(() => false))) return;

  await page.locator('#setup-window').selectOption('7');
  await page.locator('#setup-next').click();

  await page.locator('#setup-tz').selectOption('Europe/Helsinki');
  await page.locator('#setup-next').click();

  // "Nothing — do not tell me": keeps this flow independent of email/Telegram
  // delivery, which is exercised at the unit level (tests/notify.test.ts,
  // tests/telegramConnect.test.tsx) rather than through a real browser.
  await page.locator('#setup-channel').selectOption('none');
  await page.locator('#setup-next').click();

  await page.locator('#setup-elixia-email').fill(MOCK_ELIXIA_CREDENTIALS.email);
  await page.locator('#setup-elixia-password').fill(MOCK_ELIXIA_CREDENTIALS.password);
  await page.locator('#setup-finish').click();

  // Calendar sync asks for nothing required (see Setup.tsx) — its own "Next"
  // moves on regardless of what, if anything, was chosen.
  await page.locator('#setup-calendar-next').click();

  // The install page is dropped by the wizard entirely for a visitor it
  // already reads as running the installed app — which a fresh Chromium
  // context under test never is — so it is expected here, but raced against
  // the dashboard nav in case that ever changes: either is a wizard that has
  // nothing further to ask. See expectSignedIn above for why `#nav-classes`
  // and not `#menu-btn`.
  await Promise.race([
    page.locator('#setup-done').waitFor({ state: 'visible' }),
    page.locator('#nav-classes').waitFor({ state: 'visible' }),
  ]);
  if (await page.locator('#setup-done').isVisible()) {
    await page.locator('#setup-done').click();
  }

  await page.locator('#nav-classes').waitFor({ state: 'visible', timeout: 10_000 });
}

/** Switches tabs using the desktop inline nav — see expectSignedIn for why not the mobile menu. */
export async function goToTab(page: Page, id: 'classes' | 'activity' | 'settings'): Promise<void> {
  await page.locator(`#nav-${id}`).click();
}
