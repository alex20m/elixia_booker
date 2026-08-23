import Link from 'next/link';
import { LoadingScreen, SkeletonCard } from '../../components/Loading';

/**
 * The account pages, reached from a link in Settings.
 *
 * The Back link is in the bar here too: it is the only way out of this route,
 * and a visitor who lands on the loading state should not have to wait for the
 * page in order to leave it.
 */
export default function Loading() {
  return (
    <LoadingScreen
      label="Loading your account settings…"
      narrow
      actions={
        <Link className="btn btn-quiet btn-sm" href="/">
          Back
        </Link>
      }
    >
      <SkeletonCard lines={4} />
    </LoadingScreen>
  );
}
