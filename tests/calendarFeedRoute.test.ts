import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createMemoryRepo } from '@/lib/db/memoryRepo';
import { enableCalendarSync } from '@/lib/service';
import type { AppConfig } from '@/lib/appConfig';
import type { Profile } from '@/lib/types';

/**
 * The calendar feed itself — the one route in the app besides the Telegram
 * webhook that answers a caller with no session. Everything protecting it is
 * the token in the URL, so these tests are written from the position of
 * someone who has found (or guessed at) that URL.
 */

const repo = createMemoryRepo();

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  loadCalendarFeedConfig: (): AppConfig => ({ repo } as unknown as AppConfig),
}));

const { GET } = await import('@/app/api/calendar/[token]/route');

const get = (token: string): Promise<Response> =>
  GET(new Request(`http://x/api/calendar/${token}`), { params: Promise.resolve({ token }) });

const configured: Profile = {
  id: 'alice',
  bookingWindowDays: 7,
  timeZone: 'Europe/Helsinki',
  notifyChannel: 'none',
  configuredAtMs: Date.now(),
  elixiaStatus: 'ok',
};

let token: string;

beforeEach(async () => {
  await repo.upsertProfile(configured);
  const updated = await enableCalendarSync({ repo } as unknown as AppConfig, configured);
  token = updated.calendarFeedToken!;
});

describe('/api/calendar/[token]', () => {
  it('serves the calendar for a valid, enabled token', async () => {
    const response = await get(token);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');
    expect(await response.text()).toContain('BEGIN:VCALENDAR');
  });

  it('accepts the token with a trailing .ics, the address the page hands out', async () => {
    const response = await get(`${token}.ics`);

    expect(response.status).toBe(200);
  });

  it('answers a token nobody was ever given with a plain 404', async () => {
    const response = await get('f'.repeat(64));

    expect(response.status).toBe(404);
  });

  it('answers junk in the URL with 404 too, never an internal error', async () => {
    const response = await get('../../etc/passwd');

    expect(response.status).toBe(404);
  });

  it('stops serving once the owner turns sync off', async () => {
    await repo.upsertProfile({ ...(await repo.getProfile('alice'))!, calendarSyncEnabled: false });

    const response = await get(token);

    expect(response.status).toBe(404);
  });
});
