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

  const showAdmin =
    can('site:manage') ||
    can('appuser:manage') ||
    can('settings:manage') ||
    can('ruijie:manage') ||
    can('audit:view');

  const item = (href: string, label: string, icon: keyof typeof NAV_ICONS = 'dot') => {
    const active = pathname === href;
    return (
      <Link
        key={href}
        href={href}
        onClick={() => setNavOpen(false)}
        className={`group flex items-center gap-2.5 truncate rounded-lg px-3 py-2 text-sm transition ${
          active
            ? 'noc-accent-grad font-medium text-white shadow-sm shadow-accent/30'
            : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800/60'
        }`}
      >
        <span className={active ? 'text-white' : 'text-slate-500 group-hover:text-accent'}>
          {NAV_ICONS[icon]}
        </span>
        <span className="truncate">{label}</span>
      </Link>
    );
  };

  const sectionLabel = (label: string) => (
    <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
      {label}
    </div>
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
          {item('/', 'Overview', 'overview')}
          {sectionLabel('Sites')}
          {sites.data?.length ? (
            sites.data.map((s) => item(`/sites/${s.id}`, s.name, 'site'))
          ) : (
            <div className="px-3 py-1 text-xs text-slate-500">No sites</div>
          )}
          {(can('hotspot:view') || can('reports:view') || can('map:view') || can('ruijie:view') || can('firewall:view') || can('bandwidth:view')) &&
            sectionLabel('Operations')}
          {can('map:view') && item('/alerts', 'Alerts', 'alerts')}
          {can('firewall:view') && item('/access-control', 'Access Control', 'shield')}
          {can('bandwidth:view') && item('/bandwidth', 'Bandwidth', 'gauge')}
          {can('ruijie:view') && item('/ruijie', 'Ruijie WiFi', 'wifi')}
          {can('hotspot:view') && item('/hotspot', 'Hotspot', 'hotspot')}
          {can('reports:view') && item('/reports', 'Reports', 'reports')}
          {showAdmin && (
            <>
              {sectionLabel('Admin')}
              {can('site:manage') && item('/admin/sites', 'Sites & Routers', 'server')}
              {can('appuser:manage') && item('/admin/users', 'Users', 'users')}
              {can('settings:manage') && item('/admin/settings', 'Settings', 'settings')}
              {can('ruijie:manage') && item('/admin/ruijie', 'Ruijie Cloud', 'cloud')}
              {can('audit:view') && item('/admin/audit', 'Aktivitas', 'activity')}
            </>
          )}
        </nav>

        <div className="border-t border-surface-border p-3 text-xs text-slate-400">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Link
              href="/profile"
              onClick={() => setNavOpen(false)}
              className="min-w-0 rounded hover:bg-slate-200/40 dark:hover:bg-slate-800/40"
              title="My profile"
            >
              <div className="truncate font-medium text-slate-200">{user.name}</div>
              <div className="truncate">
                {user.email} · {user.role}
              </div>
            </Link>
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
          <div className="mt-3 text-[10px] text-slate-600">© {new Date().getFullYear()} RAF</div>
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

function I({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const NAV_ICONS = {
  dot: <span className="ml-1.5 mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-current opacity-60" />,
  overview: <I><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></I>,
  site: <I><path d="M3 21V9l6-4 6 4M3 21h18M15 21V11l6 4v6" /></I>,
  alerts: <I><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></I>,
  wifi: <I><path d="M5 12.55a11 11 0 0 1 14 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" /></I>,
  hotspot: <I><path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-6z" /></I>,
  shield: <I><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></I>,
  gauge: <I><path d="M12 3a9 9 0 1 0 9 9M12 12l5-3" /></I>,
  reports: <I><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="7" /><rect x="13" y="6" width="3" height="11" /></I>,
  server: <I><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><line x1="7" y1="7.5" x2="7.01" y2="7.5" /><line x1="7" y1="16.5" x2="7.01" y2="16.5" /></I>,
  users: <I><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></I>,
  settings: <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></I>,
  cloud: <I><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></I>,
  activity: <I><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></I>,
} as const;
