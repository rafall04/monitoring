// The Next.js server reverse-proxies the API and uploaded files to the backend
// over the internal network. This means the browser only ever talks to the
// frontend's own origin (one domain, or a bare IP) — no CORS, and no separate
// public "api-" hostname is needed. Override BACKEND_ORIGIN at runtime if the
// backend is not reachable as http://backend:4000 (the docker-compose default).
const backendOrigin = process.env.BACKEND_ORIGIN || 'http://backend:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the workspace package (shipped as TS source) with Next's toolchain.
  transpilePackages: ['@noc/shared'],
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${backendOrigin}/api/:path*` },
      { source: '/uploads/:path*', destination: `${backendOrigin}/uploads/:path*` },
    ];
  },
};

export default nextConfig;
