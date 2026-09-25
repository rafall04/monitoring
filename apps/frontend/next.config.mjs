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

// Baseline security headers for every route.
// CSP notes:
//  - script-src 'unsafe-inline' is required: Next injects inline hydration
//    scripts and app/layout.tsx ships a pre-paint theme-init <script>.
//  - style-src 'unsafe-inline' is required: Tailwind inline styles + Leaflet
//    divIcon markers render style attributes.
//  - img-src allows the OSM tile hosts used by MapView (plus data: URIs Leaflet
//    emits); connect-src covers same-origin /api + the WS hop to the backend
//    (ws://IP:port direct, wss://domain behind the proxy).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.tile.openstreetmap.org https://*.tile.openstreetmap.de https://*.openstreetmap.org",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the workspace package (shipped as TS source) with Next's toolchain.
  transpilePackages: ['@noc/shared'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${backendOrigin}/api/:path*` },
      { source: '/uploads/:path*', destination: `${backendOrigin}/uploads/:path*` },
      // Next proxies Upgrade requests for declared external rewrites, so the
      // browser's wss://<domain>/ws reaches the backend through the same origin —
      // no separate WS route needed at the edge tunnel.
      { source: '/ws', destination: `${backendOrigin}/ws` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
