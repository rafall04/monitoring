'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { useTheme } from '@/lib/theme';
import { useSites } from '@/lib/queries';
import { Spinner } from './ui';

export function Shell({ children }: { children: ReactNode }) {
  const { user, ready, logout, can } = useAuth();
  const { theme, toggle } = useTheme();
  const branding = useBranding();
  const router = useRouter();
  const pathname = usePathname();
  const sites = useSites();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (ready && !user) router.replace('/login');
  }, [ready, user, router]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  if (!ready)
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  if (!user) return null;

  const showAdmin = can('site:manage') || can('appuser:manage') || can('settings:manage');

  const item = (href: string, label: string) => (
    <Link
      key={href}
      href={href}
      onClick={() => setNavOpen(false)}
      className={`block truncate rounded px-3 py-2 text-sm ${
        pathname === href
          ? 'bg-accent text-white'
          : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800/60'
      }`}
    >
      {label}
    </Link>
  );

  const sectionLabel = (label: string) => (
    <div className="px-3 pb-1 pt-3 text-xs uppercase tracking-wide text-slate-500">{label}</div>
  );

  return (
    <div className="flex h-screen">
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`z-40 w-64 flex-col border-r border-surface-border bg-surface-raised md:static md:flex md:w-60 ${
          navOpen ? 'fixed inset-y-0 left-0 flex' : 'hidden'
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-4">
          <Brand orgName={branding.orgName} logoUrl={branding.logoUrl} />
          <button
            className="text-slate-400 hover:text-slate-200 md:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2">
          {item('/', 'Overview')}
          {sectionLabel('Sites')}
          {sites.data?.length ? (
            sites.data.map((s) => item(`/sites/${s.id}`, s.name))
          ) : (
            <div className="px-3 py-1 text-xs text-slate-500">No sites</div>
          )}
          {(can('hotspot:view') || can('reports:view')) && sectionLabel('Operations')}
          {can('hotspot:view') && item('/hotspot', 'Hotspot')}
          {can('reports:view') && item('/reports', 'Reports')}
          {showAdmin && (
            <>
              {sectionLabel('Admin')}
              {can('site:manage') && item('/admin/sites', 'Sites & Routers')}
              {can('appuser:manage') && item('/admin/users', 'Users')}
              {can('settings:manage') && item('/admin/settings', 'Settings')}
            </>
          )}
        </nav>

        <div className="border-t border-surface-border p-3 text-xs text-slate-400">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-200">{user.name}</div>
              <div className="truncate">
                {user.email} · {user.role}
              </div>
            </div>
            <button
              onClick={toggle}
              aria-label="Toggle theme"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="shrink-0 rounded p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
          <button onClick={() => void logout()} className="text-red-400 hover:text-red-300">
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-surface-border bg-surface-raised px-4 py-3 md:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <MenuIcon />
          </button>
          <Brand orgName={branding.orgName} logoUrl={branding.logoUrl} />
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}

function Brand({ orgName, logoUrl }: { orgName: string; logoUrl: string | null }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-lg font-semibold text-slate-100">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="h-6 w-6 shrink-0 rounded object-contain" />
      ) : (
        <span aria-hidden className="h-6 w-6 shrink-0 rounded bg-accent" />
      )}
      <span className="truncate">{orgName}</span>
    </span>
  );
}

function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
