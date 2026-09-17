import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@resume/application',
    '@resume/config',
    '@resume/domain',
    '@resume/infrastructure',
  ],
};

export default nextConfig;
