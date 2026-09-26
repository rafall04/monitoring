import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'RAF NOC',
  description: 'RAF NOC — Network Operations Center',
};

// viewportFit:'cover' lets the shell reach under the iOS notch; the mobile
// header pads itself back with env(safe-area-inset-top). themeColor tints the
// browser chrome / PWA title bar to the dark surface (both schemes — the app
// is dark-first).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f1f5f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

// Set the theme class before paint to avoid a flash. Defaults to dark (the NOC
// house style); a stored choice from the toggle wins.
const themeScript = `(function(){try{var t=localStorage.getItem('noc_theme');document.documentElement.classList.toggle('dark', t!=='light');}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
