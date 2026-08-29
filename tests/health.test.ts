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

const VARS = ['ENCRYPTION_KEY', 'DATABASE_URL', 'CRON_SECRET', 'QSTASH_TOKEN', 'APP_URL'] as const;

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
 * QStash is the mechanism that books classes, and it is deliberately
 * all-or-nothing: with any one of the token, the origin and the cron secret
 * missing it publishes nothing at all rather than publishing messages that
 * would fail hours later at delivery time (see lib/qstash.ts).
 *
 * That makes "dormant" a state the app can sit in indefinitely while looking
 * completely healthy from outside — which is the same trap this file's header
 * describes for ENCRYPTION_KEY, and it cost a missed booking before it was
 * reported here. Absence of the booking mechanism has to be visible in the one
 * place the setup guide tells you to look.
 */
describe('/api/health and the QStash booking path', () => {
  const live = () => {
    process.env.QSTASH_TOKEN = 'qstash-token';
    process.env.APP_URL = 'https://booker.example';
    process.env.CRON_SECRET = 'cron-secret';
  };

  it('reports the booking path as live when all three parts are set', async () => {
    live();
    expect(await health()).toMatchObject({ qstashConfigured: true });
  });

  it.each(['QSTASH_TOKEN', 'APP_URL', 'CRON_SECRET'] as const)(
    'reports it as not live when %s alone is missing',
    async (missing) => {
      // Each of the three is individually load-bearing. Reporting "configured"
      // on two out of three is the reading that would send someone hunting
      // through Upstash for a delivery that was never published.
      live();
      delete process.env[missing];
      expect(await health()).toMatchObject({ qstashConfigured: false });
    },
  );
});
