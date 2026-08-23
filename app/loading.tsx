import { LoadingScreen, SkeletonCard, SkeletonList } from './components/Loading';

/**
 * The dashboard route, before its server component has rendered.
 *
 * This page is `force-dynamic`, so on a cold serverless start there is a real
 * gap between the click and the first byte, and without this Next holds the
 * previous screen — or, on a first visit, nothing at all. Shaped like the
 * dashboard's own first-load state so that arriving from a navigation and
 * arriving from a reload look the same.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading Booker…">
      <SkeletonList rows={3} />
      <SkeletonCard lines={2} />
    </LoadingScreen>
  );
}
