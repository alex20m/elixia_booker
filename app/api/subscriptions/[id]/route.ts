import { mutateSubscription } from '@/lib/service';
import { handle, json, requireConfiguredUser } from '@/lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function mutate(context: Context, action: 'delete' | 'toggle'): Promise<Response> {
  return handle(async () => {
    const { config, profile, nowMs } = await requireConfiguredUser();
    const { id } = await context.params;
    await mutateSubscription(config, profile, id, action, nowMs);
    return json({ ok: true });
  });
}

export const DELETE = (_request: Request, context: Context): Promise<Response> =>
  mutate(context, 'delete');

export const PATCH = (_request: Request, context: Context): Promise<Response> =>
  mutate(context, 'toggle');
