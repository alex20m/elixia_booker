import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteNeonAuthUser, neonUserDeletionConfigured } from '@/lib/auth/neonUsers';

/**
 * Deleting a Neon Auth user goes through the Neon Console API, not the auth
 * proxy — the managed Better Auth instance has no `/delete-user` route and
 * answers 404. The endpoint is branch-scoped, so the branch has to be resolved
 * before the delete: `NEON_BRANCH_ID` when it is set, the project's default
 * branch otherwise.
 */

const API = 'https://console.neon.tech/api/v2';

const asFetch = (fn: unknown) => fn as unknown as typeof fetch;

const branchList = (branches: Array<{ id: string; default?: boolean }>): Response =>
  new Response(JSON.stringify({ branches }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('neonUserDeletionConfigured', () => {
  it('needs both the API key and the project id', () => {
    vi.stubEnv('NEON_API_KEY', '');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    expect(neonUserDeletionConfigured()).toBe(false);

    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', '');
    expect(neonUserDeletionConfigured()).toBe(false);

    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    expect(neonUserDeletionConfigured()).toBe(true);
  });
});

describe('deleteNeonAuthUser', () => {
  it('deletes the user on the project default branch, with the API key as a bearer token', async () => {
    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    vi.stubEnv('NEON_BRANCH_ID', '');

    const fetchImpl = vi.fn(async (url: string) => {
      if (url === `${API}/projects/proj-1/branches`) {
        return branchList([
          { id: 'br-dev', default: false },
          { id: 'br-main', default: true },
        ]);
      }
      return new Response(null, { status: 200 });
    });

    await deleteNeonAuthUser('user_42', { fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).toHaveBeenCalledWith(`${API}/projects/proj-1/branches`, {
      headers: { authorization: 'Bearer key-1' },
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${API}/projects/proj-1/branches/br-main/auth/users/user_42`,
      { method: 'DELETE', headers: { authorization: 'Bearer key-1' } },
    );
  });

  it('uses NEON_BRANCH_ID directly and skips the branch lookup when it is set', async () => {
    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    vi.stubEnv('NEON_BRANCH_ID', 'br-preview');

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await deleteNeonAuthUser('user_42', { fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${API}/projects/proj-1/branches/br-preview/auth/users/user_42`,
      { method: 'DELETE', headers: { authorization: 'Bearer key-1' } },
    );
  });

  it('percent-encodes the user id in the path', async () => {
    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    vi.stubEnv('NEON_BRANCH_ID', 'br-1');

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await deleteNeonAuthUser('a/b?c', { fetchImpl: asFetch(fetchImpl) });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${API}/projects/proj-1/branches/br-1/auth/users/a%2Fb%3Fc`,
      expect.anything(),
    );
  });

  it('treats a 404 on the user as already deleted', async () => {
    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    vi.stubEnv('NEON_BRANCH_ID', 'br-1');

    const fetchImpl = vi.fn(async () => new Response('{"message":"not found"}', { status: 404 }));
    await expect(
      deleteNeonAuthUser('user_42', { fetchImpl: asFetch(fetchImpl) }),
    ).resolves.toBeUndefined();
  });

  it('throws with the API detail when the delete is refused', async () => {
    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    vi.stubEnv('NEON_BRANCH_ID', 'br-1');

    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      deleteNeonAuthUser('user_42', { fetchImpl: asFetch(fetchImpl) }),
    ).rejects.toThrow('Neon API refused to delete the user (HTTP 403): forbidden');
  });

  it('throws without calling the API when the key and project id are missing', async () => {
    vi.stubEnv('NEON_API_KEY', '');
    vi.stubEnv('NEON_PROJECT_ID', '');

    const fetchImpl = vi.fn();
    await expect(
      deleteNeonAuthUser('user_42', { fetchImpl: asFetch(fetchImpl) }),
    ).rejects.toThrow('Account deletion is not configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the branch list cannot be fetched', async () => {
    vi.stubEnv('NEON_API_KEY', 'key-1');
    vi.stubEnv('NEON_PROJECT_ID', 'proj-1');
    vi.stubEnv('NEON_BRANCH_ID', '');

    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    await expect(
      deleteNeonAuthUser('user_42', { fetchImpl: asFetch(fetchImpl) }),
    ).rejects.toThrow('Neon API refused to list branches (HTTP 401)');
  });
});
