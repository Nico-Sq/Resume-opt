import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@resume/config', '@resume/infrastructure'],
};

export default nextConfig;
