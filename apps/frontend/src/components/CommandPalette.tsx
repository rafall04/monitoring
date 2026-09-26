'use client';

// =============================================================================
// Ctrl+K command palette — the NOC "where is that thing" answer. Three result
// sources: static pages (permission-filtered), sites (already-loaded list),
// and devices (debounced /devices?search=, site names resolved client-side).
// Zero new deps — plain keyboard nav + a fixed overlay.
// =============================================================================

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Device, Permission, Site } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSites } from '@/lib/queries';

interface Hit {
  id: string;
  href: string;
  group: 'Halaman' | 'Site' | 'Perangkat';
  title: string;
  sub?: string;
  icon?: ReactNode;
}

const PAGES: ReadonlyArray<{ href: string; title: string; perm: Permission | null }> = [
  { href: '/', title: 'Overview', perm: null },
  { href: '/akun', title: 'Akun Saya', perm: null },
  { href: '/alerts', title: 'Alerts', perm: 'map:view' },
  { href: '/tickets', title: 'Tiket', perm: 'tickets:view' },
  { href: '/access-control', title: 'Access Control', perm: 'firewall:view' },
  { href: '/bandwidth', title: 'Bandwidth', perm: 'bandwidth:view' },
  { href: '/diagnostics', title: 'Diagnostik', perm: 'device:diagnose' },
  { href: '/ruijie', title: 'Ruijie WiFi', perm: 'ruijie:view' },
  { href: '/ruijie/switches', title: 'Switch Ruijie', perm: 'ruijie:view' },
  { href: '/hotspot', title: 'Hotspot', perm: 'hotspot:view' },
  { href: '/reports', title: 'Reports', perm: 'reports:view' },
  { href: '/profile', title: 'Profil Saya', perm: null },
  { href: '/admin/sites', title: 'Admin · Sites & Routers', perm: 'site:manage' },
  { href: '/admin/users', title: 'Admin · Users', perm: 'appuser:manage' },
  { href: '/admin/whatsapp', title: 'Admin · WhatsApp', perm: 'whatsapp:manage' },
  { href: '/admin/settings', title: 'Admin · Settings', perm: 'settings:manage' },
  { href: '/admin/ruijie', title: 'Admin · Ruijie Cloud', perm: 'ruijie:manage' },
  { href: '/admin/audit', title: 'Admin · Aktivitas', perm: 'audit:view' },
];

const norm = (s: string) => s.toLowerCase().trim();
const match = (q: string, ...parts: Array<string | null | undefined>) =>
  parts.some((p) => p && norm(p).includes(q));

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { can } = useAuth();
  const sites = useSites();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [devices, setDevices] = useState<Device[]>([]);
  const [searching, setSearching] = useState(false);

  // Reset state whenever the palette opens; autofocus lands the cursor.
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setDevices([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const siteById = useMemo(() => {
    const m = new Map<string, Site>();
    for (const s of sites.data ?? []) m.set(s.id, s);
    return m;
  }, [sites.data]);

  // Debounced device search — fires only for ≥2 chars so the first keystroke
  // doesn't fetch a 5000-row scan for nothing.
  useEffect(() => {
    if (!open) return;
    const query = norm(q);
    if (query.length < 2 || !can('device:view')) {
      setDevices([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .get<Device[]>(`/devices?search=${encodeURIComponent(query)}&take=8`)
        .then(setDevices)
        .catch(() => setDevices([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, can]);

  const hits = useMemo<Hit[]>(() => {
    const query = norm(q);
    const out: Hit[] = [];
    for (const p of PAGES) {
      if (p.perm && !can(p.perm)) continue;
      if (query && !match(query, p.title)) continue;
      out.push({ id: `p:${p.href}`, href: p.href, group: 'Halaman', title: p.title });
    }
    for (const s of sites.data ?? []) {
      if (query && !match(query, s.name, s.region)) continue;
      out.push({
        id: `s:${s.id}`,
        href: `/sites/${s.id}`,
        group: 'Site',
        title: s.name,
        sub: s.region ?? undefined,
      });
    }
    for (const d of devices) {
      out.push({
        id: `d:${d.id}`,
        href: `/sites/${d.siteId}?device=${d.id}`,
        group: 'Perangkat',
        title: d.name,
        sub: [siteById.get(d.siteId)?.name, d.ipAddress, d.status]
          .filter(Boolean)
          .join(' · '),
      });
    }
    return out.slice(0, 24);
  }, [q, can, sites.data, devices, siteById]);

  useEffect(() => setActive(0), [q]);

  const go = (h: Hit) => {
    onClose();
    router.push(h.href);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      const h = hits[active];
      if (h) go(h);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!open) return null;
  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-3 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Lompat ke halaman"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-surface-border bg-surface-raised shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-surface-border px-3">
          <SearchIcon />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Cari halaman, site, atau perangkat…"
            className="w-full bg-transparent py-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
            role="combobox"
            aria-expanded="true"
            aria-activedescendant={hits[active]?.id}
          />
          <kbd className="hidden shrink-0 rounded border border-surface-border px-1.5 py-0.5 text-micro text-slate-500 sm:block">
            ESC
          </kbd>
        </div>
        <div className="max-h-[55vh] overflow-y-auto p-1.5" role="listbox">
          {hits.length === 0 && !searching && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              Tidak ada hasil untuk “{q}”.
            </p>
          )}
          {hits.map((h, i) => {
            const header =
              h.group !== lastGroup ? (
                <div className="px-2.5 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-slate-500">
                  {h.group}
                </div>
              ) : null;
            lastGroup = h.group;
            return (
              <div key={h.id}>
                {header}
                <button
                  type="button"
                  id={h.id}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                    i === active ? 'bg-accent/15 text-slate-100' : 'text-slate-300'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{h.title}</span>
                    {h.sub && <span className="block truncate text-2xs text-slate-500">{h.sub}</span>}
                  </span>
                  {h.group === 'Perangkat' && <Dot status={subStatus(h.sub)} />}
                </button>
              </div>
            );
          })}
          {searching && (
            <p className="px-3 py-2 text-2xs text-slate-500">Mencari perangkat…</p>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-surface-border px-3 py-2 text-micro text-slate-500">
          <span>
            <kbd className="rounded border border-surface-border px-1">↑↓</kbd> pilih
          </span>
          <span>
            <kbd className="rounded border border-surface-border px-1">Enter</kbd> buka
          </span>
          <span className="ml-auto hidden sm:inline">Ctrl+K untuk membuka lagi</span>
        </div>
      </div>
    </div>
  );
}

const subStatus = (sub?: string) =>
  sub?.endsWith('down') ? 'down' : sub?.endsWith('up') ? 'up' : 'unknown';

function Dot({ status }: { status: string }) {
  const c = status === 'up' ? '#22c55e' : status === 'down' ? '#ef4444' : '#9ca3af';
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c }} />;
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-slate-500">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/**
 * Global keyboard hook — Ctrl/Cmd+K or `/` (outside inputs) toggles the
 * palette. Mounted once by the Shell.
 */
export function usePaletteKeys(open: boolean, setOpen: (v: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!open);
      } else if (e.key === '/' && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
}
