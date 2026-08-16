/**
 * Phase 1 — API discovery harness.
 *
 * Drives a real browser against elixia.fi and records every network exchange
 * (request + response, headers and bodies) while you log in, open the group
 * class schedule, and book a class. The output is the raw material for
 * docs/api.md.
 *
 * This script is LOCAL-ONLY tooling. It is never deployed, and the Worker must
 * never depend on it — Cloudflare Workers cannot run a browser.
 *
 * Deliberately dumb about selectors: it makes a best-effort attempt to fill the
 * login form, but every phase can be driven by hand. Elixia's markup is not
 * known ahead of time, and a recorder that breaks on a changed CSS class is
 * worse than one that just asks you to click. What matters is the traffic,
 * not who clicked.
 *
 * Usage:
 *   npm run discover:headed     # first run — lets you clear 2FA
 *   npm run discover            # subsequent runs reuse the saved session
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import { config as loadEnv } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'captures', 'raw');
const AUTH_STATE = join(ROOT, 'auth-state.json');

const BASE_URL = process.env.ELIXIA_BASE_URL ?? 'https://www.elixia.fi';
const EMAIL = process.env.ELIXIA_EMAIL;
const PASSWORD = process.env.ELIXIA_PASSWORD;

const HEADED = process.argv.includes('--headed');

/** Phases we tag traffic with, so the log can be read as a story. */
type Phase = 'boot' | 'login' | 'schedule' | 'book' | 'refresh';
let phase: Phase = 'boot';

/**
 * Resource types worth recording. Images/fonts/stylesheets are noise that
 * would bury the handful of API calls we actually care about.
 */
const INTERESTING = new Set(['xhr', 'fetch', 'document', 'websocket', 'other']);

interface Exchange {
  phase: Phase;
  ts: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  statusText: string | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  /** Non-null when the body could not be read (redirects, streams, aborts). */
  note?: string;
}

function ensureDirs(): void {
  mkdirSync(RAW_DIR, { recursive: true });
}

const logPath = () => join(RAW_DIR, 'exchanges.jsonl');

function record(x: Exchange): void {
  appendFileSync(logPath(), JSON.stringify(x) + '\n', 'utf8');
  const status = x.status ?? '---';
  console.log(`  [${x.phase}] ${status} ${x.method} ${truncate(x.url, 110)}`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Bodies can be megabytes of HTML. Cap them so the log stays readable, but keep
 * enough that JSON payloads survive intact.
 */
const MAX_BODY = 200_000;

function capBody(body: string): string {
  return body.length <= MAX_BODY
    ? body
    : body.slice(0, MAX_BODY) + `\n…[truncated ${body.length - MAX_BODY} bytes]`;
}

function attachRecorder(context: BrowserContext): void {
  context.on('response', async (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    if (!INTERESTING.has(resourceType)) return;

    let responseBody: string | null = null;
    let note: string | undefined;
    try {
      // Redirects and 204s have no body; body() throws rather than returning ''.
      // Decoded via TextDecoder rather than Buffer#toString so this file stays
      // unambiguous with the Workers types loaded for src/.
      const buf = await response.body();
      responseBody = capBody(new TextDecoder().decode(buf));
    } catch (err) {
      note = `response body unavailable: ${(err as Error).message}`;
    }

    record({
      phase,
      ts: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType,
      requestHeaders: await request.allHeaders(),
      requestBody: request.postData(),
      status: response.status(),
      statusText: response.statusText(),
      responseHeaders: await response.allHeaders(),
      responseBody,
      ...(note ? { note } : {}),
    });
  });

  // Failed requests never produce a response event, but a blocked or aborted
  // call is itself a finding (rate limiting, bot detection).
  context.on('requestfailed', (request) => {
    if (!INTERESTING.has(request.resourceType())) return;
    record({
      phase,
      ts: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      requestHeaders: request.headers(),
      requestBody: request.postData(),
      status: null,
      statusText: null,
      responseHeaders: null,
      responseBody: null,
      note: `request failed: ${request.failure()?.errorText ?? 'unknown'}`,
    });
  });
}

/**
 * Snapshot everything the browser is holding that could be an auth credential.
 * The Worker will have to reproduce whichever of these actually matters, so we
 * capture all three stores rather than guessing which one Elixia uses.
 */
async function snapshotAuth(context: BrowserContext, page: Page, label: string): Promise<void> {
  const cookies = await context.cookies();

  let storage: { localStorage: unknown; sessionStorage: unknown } | { error: string };
  try {
    storage = await page.evaluate(() => ({
      localStorage: Object.fromEntries(
        Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]),
      ),
      sessionStorage: Object.fromEntries(
        Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]),
      ),
    }));
  } catch (err) {
    storage = { error: (err as Error).message };
  }

  const out = join(RAW_DIR, `auth-snapshot-${label}.json`);
  writeFileSync(out, JSON.stringify({ label, url: page.url(), cookies, storage }, null, 2), 'utf8');
  console.log(`\n  → auth snapshot written: ${out}`);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function banner(title: string, body: string[]): Promise<void> {
  console.log(`\n${'='.repeat(72)}\n  ${title}\n${'='.repeat(72)}`);
  for (const line of body) console.log(`  ${line}`);
  console.log('');
}

/**
 * Best-effort autofill. Returns true only if it is confident it submitted the
 * form; otherwise the caller falls back to manual login. We never treat a
 * guessed selector as authoritative.
 */
async function tryAutoLogin(page: Page): Promise<boolean> {
  if (!EMAIL || !PASSWORD) return false;

  const emailField = page
    .locator(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="username"]',
    )
    .first();
  const passwordField = page
    .locator('input[type="password"], input[autocomplete="current-password"]')
    .first();

  try {
    await emailField.waitFor({ state: 'visible', timeout: 15_000 });
    await emailField.fill(EMAIL);

    // Some flows reveal the password field only after the email is submitted.
    if (!(await passwordField.isVisible().catch(() => false))) {
      await emailField.press('Enter');
      await page.waitForTimeout(2000);
    }

    await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
    await passwordField.fill(PASSWORD);
    await passwordField.press('Enter');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  ensureDirs();
  writeFileSync(logPath(), '', 'utf8'); // fresh log per run

  if (!EMAIL || !PASSWORD) {
    console.warn(
      '\n  ELIXIA_EMAIL / ELIXIA_PASSWORD not set in .env — you will need to log in by hand.\n',
    );
  }

  const reusingSession = existsSync(AUTH_STATE);
  if (!HEADED && !reusingSession) {
    console.error(
      '\n  No saved session found. Run `npm run discover:headed` first so you can\n' +
        '  complete login and clear any 2FA challenge.\n',
    );
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: !HEADED,
    // Elixia is a normal consumer site; a default-looking UA avoids tripping
    // trivial automation checks during discovery. If this turns out to matter,
    // that is itself a Phase 1 finding worth writing down.
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    ...(reusingSession ? { storageState: AUTH_STATE } : {}),
    locale: 'fi-FI',
    timezoneId: 'Europe/Helsinki',
    recordHar: { path: join(RAW_DIR, 'session.har'), content: 'embed' },
  });

  attachRecorder(context);
  const page = await context.newPage();

  // ---- Phase: login -------------------------------------------------------
  phase = 'login';
  await banner('PHASE 1/3 — LOGIN', [
    `Opening ${BASE_URL}`,
    'Recording every request. If autofill fails, just log in by hand.',
  ]);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  if (!reusingSession) {
    const submitted = await tryAutoLogin(page);
    console.log(
      submitted
        ? '  Autofill submitted the login form.'
        : '  Could not autofill — please log in manually in the browser window.',
    );
  } else {
    console.log('  Reusing saved session from auth-state.json.');
  }

  await prompt(
    '\n  When you are LOGGED IN (clear any 2FA now), press Enter to continue… ',
  );
  await snapshotAuth(context, page, 'after-login');
  await context.storageState({ path: AUTH_STATE });
  console.log(`  → session saved to ${AUTH_STATE} (gitignored)`);

  // ---- Phase: schedule ----------------------------------------------------
  phase = 'schedule';
  await banner('PHASE 2/3 — GROUP CLASS SCHEDULE', [
    'In the browser: open the group class schedule for your usual centre.',
    'Change the date / centre filter a couple of times — that reveals how the',
    'listing endpoint is parameterised.',
  ]);
  await prompt('  Press Enter when the schedule is loaded… ');

  // ---- Phase: book --------------------------------------------------------
  phase = 'book';
  await banner('PHASE 3/3 — BOOK A CLASS', [
    'In the browser: book one real class. If a class is full, also try joining',
    'the waitlist — the waitlist call is often a different endpoint.',
    '',
    'This books a REAL class on your account. Cancel it afterwards if you do',
    'not want it.',
  ]);
  await prompt('  Press Enter once the booking has gone through… ');

  // ---- Phase: refresh -----------------------------------------------------
  phase = 'refresh';
  await banner('BONUS — TOKEN REFRESH', [
    'Leave the tab idle, or hard-reload the schedule a few times. If the client',
    'silently refreshes its token, we want that exchange on record — the Worker',
    'has to reproduce it.',
  ]);
  await prompt('  Press Enter to finish and close the browser… ');

  await snapshotAuth(context, page, 'end-of-session');

  await context.close(); // flushes the HAR
  await browser.close();

  console.log(
    `\n  Done.\n` +
      `    raw log : ${logPath()}\n` +
      `    har     : ${join(RAW_DIR, 'session.har')}\n\n` +
      `  captures/raw/ is gitignored — it contains live tokens.\n` +
      `  Run \`npm run redact\` to produce a committable summary.\n`,
  );
}

main().catch((err) => {
  console.error('\n  Discovery failed:', err);
  process.exit(1);
});
