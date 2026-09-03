import { sendTestNotification } from '@/lib/service';
import { handle, json, requireConfiguredUser } from '@/lib/http';

export const runtime = 'nodejs';

/**
 * Send one test alert to whichever channel this account has chosen, so a user
 * can confirm delivery without waiting for a real booking to fire one.
 */
export async function POST(): Promise<Response> {
  return handle(async () => {
    const { config, profile } = await requireConfiguredUser();
    const result = await sendTestNotification(config, profile);
    return json(result);
  });
}
