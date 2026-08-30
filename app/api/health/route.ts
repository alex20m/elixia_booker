import { API_DISCOVERED } from '@/lib/elixia';
import { encryptionConfigured, qstashConfigured } from '@/lib/appConfig';
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
      encryptionConfigured: encryptionConfigured(),
      // The booking mechanism itself, both halves of it: publishing the
      // schedule (QSTASH_TOKEN + APP_URL) and authenticating the deliveries it
      // triggers (QSTASH_CURRENT_SIGNING_KEY + QSTASH_NEXT_SIGNING_KEY). False
      // means classes are not being booked, however green everything above
      // looks.
      qstashConfigured: qstashConfigured(),
    }),
  );
}
