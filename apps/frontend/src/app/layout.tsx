import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'RAF NOC',
  description: 'RAF NOC — Network Operations Center',
};

// Set the theme class before paint to avoid a flash. Defaults to dark (the NOC
// house style); a stored choice from the toggle wins.
const themeScript = `(function(){try{var t=localStorage.getItem('noc_theme');document.documentElement.classList.toggle('dark', t!=='light');}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
