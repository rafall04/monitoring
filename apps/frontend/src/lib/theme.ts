'use client';

import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

/**
 * Read/toggle the active theme. The initial class is set pre-hydration by the
 * inline script in the root layout; this hook keeps React state in sync and
 * persists the user's choice.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    setThemeState(
      document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    );
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem('noc_theme', next);
    } catch {
      /* ignore storage failures (private mode etc.) */
    }
  };

  return { theme, toggle };
}
