import { LoadingScreen, SkeletonCard } from '../../components/Loading';

/**
 * Sign in, sign up, password reset — Neon's components, in our frame.
 *
 * Deliberately unspecific about which of them is coming: one file serves every
 * path under /auth, and naming the wrong one would be worse than naming none.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading…" narrow>
      <SkeletonCard lines={4} />
    </LoadingScreen>
  );
}
