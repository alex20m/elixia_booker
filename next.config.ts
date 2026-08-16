import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Surfacing type errors at build time is the point of using TypeScript here:
  // a deploy that silently ships a type error would defeat it.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
