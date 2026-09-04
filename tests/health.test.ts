import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/health/route';

/**
 * /api/health is what the setup guide tells you to curl to confirm a
 * deployment is configured, so it has to report every variable whose absence
 * breaks the app — not just the ones a provider supplies.
 *
 * ENCRYPTION_KEY is the one nothing provisions for you. When it was missing,
 * health answered `ok: true` with every field green while every signed-in
 * request 500'd, which sent the search in exactly the wrong direction.
 */

const VARS = [
  'ENCRYPTION_KEY',
  'DATABASE_URL',
  'QSTASH_TOKEN',
  'APP_URL',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'RESEND_API_KEY',
  'NOTIFY_FROM_EMAIL',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const health = async (): Promise<Record<string, unknown>> =>
  (await (await GET()).json()) as Record<string, unknown>;

describe('/api/health', () => {
  it('reports the encryption key as missing when it is not set', async () => {
    expect(await health()).toMatchObject({ encryptionConfigured: false });
  });

  it('reports the encryption key as present once it is set', async () => {
    process.env.ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    expect(await health()).toMatchObject({ encryptionConfigured: true });
  });

  it('answers without the encryption key rather than failing the check', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});

/**
 * QStash is the only mechanism that books classes, and health has to report
 * the *whole* round trip, not just its outbound half: publishing the schedule
 * needs QSTASH_TOKEN and APP_URL, and authenticating the deliveries that
 * schedule then triggers needs both signing keys. A deployment missing any one
 * part is the worst case — messages are published and every delivery 401s,
 * hours later, on a path nobody is watching — while looking completely healthy
 * from outside. That is the same trap this file's header describes for
 * ENCRYPTION_KEY, and it cost a missed booking before it was reported here.
 */
describe('/api/health and the QStash booking path', () => {
  const PARTS = [
    'QSTASH_TOKEN',
    'APP_URL',
    'QSTASH_CURRENT_SIGNING_KEY',
    'QSTASH_NEXT_SIGNING_KEY',
  ] as const;

  const live = () => {
    process.env.QSTASH_TOKEN = 'qstash-token';
    process.env.APP_URL = 'https://booker.example';
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_cur';
    process.env.QSTASH_NEXT_SIGNING_KEY = 'sig_next';
  };

  it('reports the booking path as live when every part is set', async () => {
    live();
    expect(await health()).toMatchObject({ qstashConfigured: true });
  });

  it.each(PARTS)('reports it as not live when %s alone is missing', async (missing) => {
    // Each part is individually load-bearing. Reporting "configured" while one
    // is absent is the reading that sends someone hunting through Upstash for a
    // delivery that was never published, or never accepted.
    live();
    delete process.env[missing];
    expect(await health()).toMatchObject({ qstashConfigured: false });
  });

  it('no longer reports a separate cronConfigured field', async () => {
    // The shared CRON_SECRET is gone; the cron guard is the QStash signature,
    // whose readiness qstashConfigured already covers.
    live();
    expect(await health()).not.toHaveProperty('cronConfigured');
  });
});

/**
 * Email is the channel offered by default, and unlike every other subsystem
 * on this page it had no reporting at all: a deployment with no Resend key
 * and no verified sender answered `ok: true` with an otherwise-green health
 * check while `sendEmail` (lib/email.ts) silently dropped every alert,
 * including the one saying booking itself had stopped. That is the exact
 * trap this file's header describes for ENCRYPTION_KEY and the header above
 * describes for QStash — reported here for the same reason.
 */
describe('/api/health and email notifications', () => {
  const live = () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.NOTIFY_FROM_EMAIL = 'Booker <bot@example.com>';
  };

  it('reports email as configured when both parts are set', async () => {
    live();
    expect(await health()).toMatchObject({ emailConfigured: true });
  });

  it('reports email as not configured when the Resend key is missing', async () => {
    live();
    delete process.env.RESEND_API_KEY;
    expect(await health()).toMatchObject({ emailConfigured: false });
  });

  it('reports email as not configured when there is no verified sender', async () => {
    live();
    delete process.env.NOTIFY_FROM_EMAIL;
    expect(await health()).toMatchObject({ emailConfigured: false });
  });

  it('reports email as not configured when neither is set', async () => {
    expect(await health()).toMatchObject({ emailConfigured: false });
  });

  it('reports email as not configured when the sender is missing its closing bracket', async () => {
    // The reported bug this guards: a NOTIFY_FROM_EMAIL like
    // "Elixia Booker <noreply@alexmecklin.com" looks set, but Resend rejects
    // it with a 422 on every send. Treated the same as "not configured" so
    // the gap shows up here rather than only after every alert has failed.
    live();
    process.env.NOTIFY_FROM_EMAIL = 'Elixia Booker <noreply@alexmecklin.com';
    expect(await health()).toMatchObject({ emailConfigured: false });
  });
});
