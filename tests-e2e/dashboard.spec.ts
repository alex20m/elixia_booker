import { test, expect } from '@playwright/test';
import { completeSetupIfNeeded, goToTab, signIn } from './helpers';

/**
 * Drives the real dashboard in a real browser: the setup wizard, adding and
 * managing a class subscription, editing booking settings, and signing out.
 *
 * tests-e2e/login.spec.ts only ever proves that a sign-in resolves — with no
 * `ENCRYPTION_KEY` set, everything past it was unreachable and it stopped at
 * `DashboardApp`'s own "could not load your account" banner. Now that
 * playwright.config.ts sets `ENCRYPTION_KEY` and `MOCK_ELIXIA=1`, a real
 * sign-in reaches a real, bookable dashboard (backed by the in-memory repo —
 * see lib/appConfig.ts — and lib/mock.ts's stand-in Elixia backend), so this
 * is the layer the vitest suite in tests/ cannot reach: the combobox pickers
 * in AddClass, the pause/resume/remove buttons, the settings form, and the
 * sign-out confirmation, exactly as a browser renders and wires them up.
 *
 * TEST_USER's account is shared across every spec file in this run (one
 * webServer process, one in-memory repo — see playwright.config.ts), so every
 * test here calls `completeSetupIfNeeded` rather than assuming a fresh
 * account, and every test that adds a subscription removes it again before
 * finishing so it does not leak into a sibling test's assertions.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await completeSetupIfNeeded(page);
});

/** The row in the Classes tab's Upcoming bookings list for one class name. */
function subscriptionRow(page: import('@playwright/test').Page, className: string) {
  return page.locator('#subs-list .row', { hasText: className });
}

async function addClass(
  page: import('@playwright/test').Page,
  { center, className, slotLabel }: { center: string; className: string; slotLabel: string },
): Promise<void> {
  const centerInput = page.locator('#s-center');
  await expect(centerInput).toBeEnabled();
  await centerInput.fill(center);

  const classInput = page.locator('#s-class');
  await expect(classInput).toBeEnabled();
  await classInput.fill(className);

  const slotInput = page.locator('#s-slot');
  await expect(slotInput).toBeEnabled();
  await slotInput.fill(slotLabel);
  // Typing a value that matches an option exactly selects it (see
  // Combobox's `type` in AddClass.tsx) but leaves the option list open —
  // only a blur or Escape closes it — and the open list floats directly over
  // the "Add class" button below, swallowing the click meant for it.
  await slotInput.press('Escape');

  await expect(page.locator('#add-btn')).toBeEnabled();
  await page.locator('#add-btn').click();
}

test('adds a class and shows it in Upcoming bookings, then removes it', async ({ page }) => {
  await addClass(page, { center: 'Tapiola', className: 'Bodypump', slotLabel: 'Monday 09:00' });

  const row = subscriptionRow(page, 'Bodypump');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText('09:00');
  await expect(row).toContainText('Tapiola');

  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(subscriptionRow(page, 'Bodypump')).toHaveCount(0, { timeout: 10_000 });
});

test('pauses a class without losing it, then resumes it', async ({ page }) => {
  await addClass(page, {
    center: 'Tapiola',
    className: 'Yoga',
    slotLabel: 'Monday 17:00',
  });

  const row = subscriptionRow(page, 'Yoga');
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Instructors come from the same mock timetable AddClass reads its slots
  // from (lib/mock.ts), so a class that lists one should show it.
  await expect(row).toContainText('Maija Meikäläinen');

  await row.getByRole('button', { name: 'Pause' }).click();
  await expect(row).toHaveClass(/is-paused/, { timeout: 10_000 });
  await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();

  await row.getByRole('button', { name: 'Resume' }).click();
  await expect(row).not.toHaveClass(/is-paused/, { timeout: 10_000 });
  await expect(row.getByRole('button', { name: 'Pause' })).toBeVisible();

  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(subscriptionRow(page, 'Yoga')).toHaveCount(0, { timeout: 10_000 });
});

test('saves changed booking settings and keeps them after a reload', async ({ page }) => {
  await goToTab(page, 'settings');

  const tier = page.locator('#tier');
  const timezone = page.locator('#tz');
  const original = { tier: await tier.inputValue(), timezone: await timezone.inputValue() };

  // Whichever tier and zone the account already has (from a previous test's
  // setup run), pick the other tier and a different zone so the save is a
  // real, observable change rather than a no-op that would pass regardless.
  const nextTier = original.tier === '7' ? '14' : '7';
  const nextZone = original.timezone === 'Europe/Stockholm' ? 'Europe/Helsinki' : 'Europe/Stockholm';

  await tier.selectOption(nextTier);
  await timezone.selectOption(nextZone);

  const saveButton = page.locator('#save-btn');
  await saveButton.click();
  await expect(saveButton).toHaveText('Saved', { timeout: 10_000 });

  await page.reload();
  await goToTab(page, 'settings');
  await expect(page.locator('#tier')).toHaveValue(nextTier, { timeout: 10_000 });
  await expect(page.locator('#tz')).toHaveValue(nextZone);

  // Restored rather than left changed, so this test does not change what a
  // sibling test (or a re-run of this one) finds the account already set to.
  await page.locator('#tier').selectOption(original.tier);
  await page.locator('#tz').selectOption(original.timezone);
  await page.locator('#save-btn').click();
  await expect(page.locator('#save-btn')).toHaveText('Saved', { timeout: 10_000 });
});

test('signs out from Settings and returns to the signed-out landing page', async ({ page }) => {
  await goToTab(page, 'settings');

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#signout-confirm-dialog')).toBeVisible();

  await page.locator('#signout-confirm-btn').click();

  await expect(page.locator('#auth-btn')).toBeVisible({ timeout: 10_000 });
});
