'use client';

import { createAuthClient } from '@neondatabase/auth/next';

/** Browser-side Neon Auth client, talking to /api/auth/* on this app's own origin. */
export const authClient = createAuthClient();
