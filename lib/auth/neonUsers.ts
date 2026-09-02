/**
 * Deleting a Neon Auth user.
 *
 * Every other auth call the app makes is proxied to the managed Better Auth
 * instance (see app/api/auth/[...path]/route.ts). Account deletion cannot go
 * that way: the managed instance does not expose Better Auth's own
 * `/delete-user` route, so a request to it comes back 404. Neon's supported way
 * to remove a user is the Console API instead:
 *
 *   DELETE /api/v2/projects/{project_id}/branches/{branch_id}/auth/users/{id}
 *   https://neon.com/docs/reference/api/auth/delete-branch-neon-auth-user
 *
 * It is branch-scoped because the `neon_auth` schema is per-branch: the user
 * has to be removed on the branch this deployment's database actually points
 * at. `NEON_BRANCH_ID` names it when set (useful for a preview branch);
 * otherwise the project's default branch is looked up and used.
 *
 * Needs `NEON_API_KEY` — minted by hand in the Neon console, see README — and
 * `NEON_PROJECT_ID`, which the Vercel–Neon integration already supplies.
 */

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

type FetchImpl = typeof fetch;

/** Whether the app has what it needs to delete a Neon Auth user. */
export function neonUserDeletionConfigured(): boolean {
  return Boolean(process.env.NEON_API_KEY && process.env.NEON_PROJECT_ID);
}

async function resolveBranchId(
  projectId: string,
  apiKey: string,
  fetchImpl: FetchImpl,
): Promise<string> {
  const explicit = process.env.NEON_BRANCH_ID;
  if (explicit) return explicit;

  const response = await fetchImpl(`${NEON_API_BASE}/projects/${projectId}/branches`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Neon API refused to list branches (HTTP ${response.status})`);
  }

  const body = (await response.json()) as {
    branches?: Array<{ id: string; default?: boolean }>;
  };
  const branch = body.branches?.find((b) => b.default) ?? body.branches?.[0];
  if (!branch) throw new Error('Neon API returned no branches for the project');

  return branch.id;
}

/**
 * Remove a user from Neon Auth.
 *
 * Resolves once the identity is gone — including when it was already gone: a
 * 404 on the user is treated as success so a retry after a partial failure
 * still completes. Throws on anything else, with a message the caller can put
 * in front of the user.
 */
export async function deleteNeonAuthUser(
  userId: string,
  { fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {},
): Promise<void> {
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error(
      'Account deletion is not configured: set NEON_API_KEY and NEON_PROJECT_ID.',
    );
  }

  const branchId = await resolveBranchId(projectId, apiKey, fetchImpl);
  const response = await fetchImpl(
    `${NEON_API_BASE}/projects/${projectId}/branches/${branchId}/auth/users/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` } },
  );

  if (response.ok || response.status === 404) return;

  const detail = (await response.text().catch(() => '')).trim();
  throw new Error(
    `Neon API refused to delete the user (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
  );
}
