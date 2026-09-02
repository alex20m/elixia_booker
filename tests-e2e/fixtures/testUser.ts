/**
 * The one account tests-e2e/fixtures/fakeNeonAuth.ts recognizes.
 *
 * Split out from that file on purpose: the server file has a side effect
 * (it binds a port on import), so the spec file importing just this constant
 * must not also pull that in — see the comment in fakeNeonAuth.ts.
 */
export const TEST_USER = {
  email: 'e2e@example.com',
  password: 'correct-horse-battery-staple',
  id: 'e2e-user-1',
};
