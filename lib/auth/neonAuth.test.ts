import { afterEach, describe, expect, it, vi } from 'vitest';
import { authConfigured } from './neonAuth';

const VALID_SECRET = 'a'.repeat(32);

describe('authConfigured', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false when neither variable is set', () => {
    vi.stubEnv('NEON_AUTH_BASE_URL', '');
    vi.stubEnv('NEON_AUTH_COOKIE_SECRET', '');
    expect(authConfigured()).toBe(false);
  });

  it('is false when the base URL is missing', () => {
    vi.stubEnv('NEON_AUTH_BASE_URL', '');
    vi.stubEnv('NEON_AUTH_COOKIE_SECRET', VALID_SECRET);
    expect(authConfigured()).toBe(false);
  });

  it('is false when the cookie secret is missing', () => {
    vi.stubEnv('NEON_AUTH_BASE_URL', 'https://example.neon.tech');
    vi.stubEnv('NEON_AUTH_COOKIE_SECRET', '');
    expect(authConfigured()).toBe(false);
  });

  it('is false when the cookie secret is shorter than 32 characters', () => {
    vi.stubEnv('NEON_AUTH_BASE_URL', 'https://example.neon.tech');
    vi.stubEnv('NEON_AUTH_COOKIE_SECRET', 'a'.repeat(31));
    expect(authConfigured()).toBe(false);
  });

  it('is true when both variables are set and the secret is long enough', () => {
    vi.stubEnv('NEON_AUTH_BASE_URL', 'https://example.neon.tech');
    vi.stubEnv('NEON_AUTH_COOKIE_SECRET', VALID_SECRET);
    expect(authConfigured()).toBe(true);
  });
});
