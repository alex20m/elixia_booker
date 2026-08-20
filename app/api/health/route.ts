import { API_DISCOVERED } from '@/lib/elixia';
import { authConfigured } from '@/lib/auth/neonAuth';
import { databaseConfigured } from '@/lib/db/neon';
import { handle, json } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Deliberately reports configuration presence, never any secret value. */
export async function GET(): Promise<Response> {
  return handle(async () =>
    json({
      ok: true,
      apiDiscovered: API_DISCOVERED,
      mock: (process.env.MOCK_ELIXIA ?? '') === '1',
      dryRun: (process.env.DRY_RUN ?? '') === '1',
      databaseConfigured: databaseConfigured(),
      authConfigured: authConfigured(),
      cronConfigured: Boolean(process.env.CRON_SECRET),
    }),
  );
}
