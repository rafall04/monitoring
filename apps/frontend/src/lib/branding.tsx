'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import type { BrandingPublic } from '@noc/shared';
import { api } from './api';

const DEFAULT_BRANDING: BrandingPublic = {
  orgName: 'RAF NOC',
  logoUrl: null,
  accentRgb: '59 130 246',
  themeDefault: 'dark',
};

/** Public branding (org name, logo, accent color, default theme). Cached
 *  long — the login page also depends on it. */
export function useBranding(): BrandingPublic {
  const q = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<BrandingPublic>('/settings/branding'),
    staleTime: 5 * 60_000,
    retry: 0,
  });
  return q.data ?? DEFAULT_BRANDING;
}

/**
 * Applies the branding to the live document: sets --accent CSS var, sets the
 * default theme class if the user hasn't picked one, and updates document.title
 * + favicon (when a logoUrl is set). Renders nothing.
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const b = useBranding();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('--accent', b.accentRgb);
  }, [b.accentRgb]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = b.orgName;
  }, [b.orgName]);

  useEffect(() => {
    if (typeof document === 'undefined' || !b.logoUrl) return;
    const link =
      (document.querySelector("link[rel='icon']") as HTMLLinkElement | null) ??
      (() => {
        const el = document.createElement('link');
        el.rel = 'icon';
        document.head.appendChild(el);
        return el;
      })();
    link.href = b.logoUrl;
  }, [b.logoUrl]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    // Only apply the org default when the user hasn't made an explicit choice.
    try {
      const stored = localStorage.getItem('noc_theme');
      if (!stored) {
        document.documentElement.classList.toggle('dark', b.themeDefault !== 'light');
      }
    } catch {
      /* ignore */
    }
  }, [b.themeDefault]);

  return <>{children}</>;
}
