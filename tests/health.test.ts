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

const VARS = ['ENCRYPTION_KEY', 'DATABASE_URL', 'CRON_SECRET'] as const;

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
