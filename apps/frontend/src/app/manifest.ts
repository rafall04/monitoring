import type { MetadataRoute } from 'next';

/**
 * Installable-PWA manifest (App Router convention → /manifest.webmanifest).
 * Lets a NOC phone/wall display "Add to Home Screen" and launch standalone —
 * no browser chrome stealing the map. Icons reuse the app's SVG mark; SVG is
 * fine for Chrome/Edge (the targets on ops devices), others ignore it.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RAF NOC — Network Operations Center',
    short_name: 'RAF NOC',
    description: 'Pemantauan jaringan site & hotspot MikroTik.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b1220',
    theme_color: '#0b1220',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
