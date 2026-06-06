/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the workspace package (shipped as TS source) with Next's toolchain.
  transpilePackages: ['@noc/shared'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
