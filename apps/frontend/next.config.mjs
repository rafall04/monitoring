// The Next.js server reverse-proxies the API and uploaded files to the backend
// over the internal network. This means the browser only ever talks to the
// frontend's own origin (one domain, or a bare IP) — no CORS, and no separate
// public "api-" hostname is needed.
//
// IMPORTANT: `next build` resolves rewrites() once and bakes the destination
// URLs into .next/routes-manifest.json — BACKEND_ORIGIN is a BUILD-TIME input
// (Docker build arg / build env), not a runtime override. It is also read at
// runtime by lib/api.ts for server-side calls, which is the only place the
// container env still matters.
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
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(self)',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
