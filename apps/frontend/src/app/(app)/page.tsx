'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Site, SiteSummary } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { qk, useRuijieRouters, useSites } from '@/lib/queries';
import {
  Badge,
  ErrorState,
  IconTile,
  Loading,
  MetricCard,
  Page,
  PageBody,
  PageHeader,
  SectionHeader,
  Spinner,
} from '@/components/ui';

function Ic({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const ICON = {
  health: 'M22 12h-4l-3 9L9 3l-3 9H2',
  up: 'M20 6 9 17l-5-5',
  down: 'M18 6 6 18M6 6l12 12',
  unknown: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  factory: 'M3 21V9l6-4 6 4M3 21h18M15 21V11l6 4v6',
  wifi: 'M5 12.6a11 11 0 0 1 14 0M1.4 9a16 16 0 0 1 21.2 0M8.5 16.1a6 6 0 0 1 7 0M12 20h.01',
};

/** Health → color tone for a site, driven by down/unknown counts. */
type HealthTone = 'emerald' | 'amber' | 'red' | 'slate';
function healthTone(s?: SiteSummary): HealthTone {
  if (!s) return 'slate';
  if (s.down > 0) return 'red';
  if (s.unknown > 0) return 'amber';
  return 'emerald';
}
const BAR: Record<HealthTone, string> = {
  emerald: '#34d399',
  amber: '#fbbf24',
  red: '#f87171',
  slate: '#64748b',
};

function SiteCard({ site, summary }: { site: Site; summary?: SiteSummary }) {
  const s = summary;
  const tone = healthTone(s);
  const pct = s ? s.availabilityPct : 0;
  return (
    <Link href={`/sites/${site.id}`}>
      <div className="noc-elev flex h-full flex-col rounded-xl border border-surface-border bg-surface-raised p-4 shadow-sm shadow-black/20">
        <div className="flex items-center gap-3">
          <IconTile tone={tone}>
            <Ic d={ICON.factory} />
          </IconTile>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold text-slate-100">{site.name}</h3>
            <div className="truncate text-[11px] text-slate-500">
              {site.region?.trim() || 'Tanpa kabupaten'}
            </div>
          </div>
          <Badge tone="sky">{site.mapMode === 'geo' ? 'geo' : 'denah'}</Badge>
        </div>

        {s ? (
          <>
            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge tone="emerald">{s.up} up</Badge>
                {s.down > 0 && <Badge tone="red">{s.down} down</Badge>}
                {s.unknown > 0 && <Badge tone="slate">{s.unknown} ?</Badge>}
                {s.maintenance > 0 && <Badge tone="sky">{s.maintenance} mnt</Badge>}
              </div>
              <div className="text-right leading-none">
                <span className="text-2xl font-semibold text-slate-100">{pct}</span>
                <span className="text-sm text-slate-500">%</span>
              </div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: BAR[tone] }} />
            </div>
            {s.currentlyDown.length > 0 && (
              <ul className="mt-3 space-y-0.5 border-t border-surface-border pt-2 text-xs text-red-300/90">
                {s.currentlyDown.slice(0, 3).map((d) => (
                  <li key={d.deviceId} className="flex items-center gap-1.5 truncate">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                    <span className="truncate">{d.name}</span>
                  </li>
                ))}
                {s.currentlyDown.length > 3 && (
                  <li className="text-slate-500">+{s.currentlyDown.length - 3} lagi…</li>
                )}
              </ul>
            )}
          </>
        ) : (
          <div className="mt-3">
            <Spinner />
          </div>
        )}
      </div>
    </Link>
  );
}

export default function OverviewPage() {
  const { can } = useAuth();
  const sites = useSites();
  const list = sites.data ?? [];

  const summaries = useQueries({
    queries: list.map((s) => ({
      queryKey: qk.siteSummary(s.id),
      queryFn: () => api.get<SiteSummary>(`/sites/${s.id}/summary`),
      refetchInterval: 20000,
    })),
  });
  const summaryById = new Map<string, SiteSummary>();
  list.forEach((s, i) => {
    const d = summaries[i]?.data;
    if (d) summaryById.set(s.id, d);
  });

  const ruijie = useRuijieRouters(can('ruijie:view'));
  const wifi = ruijie.data ?? [];
  const wifiClients = wifi.reduce((n, r) => n + r.clientCount, 0);
  const wifiOnline = wifi.filter((r) => r.online).length;

  const groups = new Map<string, Site[]>();
  for (const s of list) {
    const key = s.region?.trim() || 'Tanpa kabupaten';
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  const agg = list.reduce(
    (a, s) => {
      const sm = summaryById.get(s.id);
      if (sm) {
        a.up += sm.up;
        a.down += sm.down;
        a.unknown += sm.unknown;
        a.maintenance += sm.maintenance;
        a.total += sm.total;
      }
      return a;
    },
    { up: 0, down: 0, unknown: 0, maintenance: 0, total: 0 },
  );
  const monitored = agg.up + agg.down;
  const availability = monitored > 0 ? Math.round((agg.up / monitored) * 1000) / 10 : 100;

  const regionRollup = (sitesIn: Site[]) => {
    let up = 0,
      down = 0,
      total = 0;
    for (const s of sitesIn) {
      const sm = summaryById.get(s.id);
      if (sm) {
        up += sm.up;
        down += sm.down;
        total += sm.total;
      }
    }
    return { up, down, total };
  };

  return (
    <Page>
      <PageHeader title="Overview" subtitle="Ringkasan kesehatan seluruh site yang bisa kamu akses." />
      <PageBody>
        {sites.isLoading && <Loading />}
        {sites.isError && (
          <ErrorState onRetry={() => void sites.refetch()}>Gagal memuat daftar site.</ErrorState>
        )}
        {!sites.isLoading && !sites.isError && list.length === 0 && (
          <p className="text-slate-400">Belum ada site yang ditugaskan. Minta admin memberi akses.</p>
        )}

        {list.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <MetricCard
              label="Availability"
              value={`${availability}%`}
              hint={`${monitored} dipantau`}
              icon={<Ic d={ICON.health} />}
              tone={agg.down > 0 ? 'red' : 'emerald'}
            />
            <MetricCard label="Perangkat up" value={agg.up} icon={<Ic d={ICON.up} />} tone="emerald" />
            <MetricCard
              label="Down"
              value={agg.down}
              hint={agg.down > 0 ? 'perlu perhatian' : 'aman'}
              icon={<Ic d={ICON.down} />}
              tone={agg.down > 0 ? 'red' : 'slate'}
            />
            <MetricCard label="Tidak diketahui" value={agg.unknown} icon={<Ic d={ICON.unknown} />} tone="amber" />
            <MetricCard label="Pabrik" value={list.length} hint={`${groups.size} kabupaten`} icon={<Ic d={ICON.factory} />} tone="violet" />
            {can('ruijie:view') && (
              <MetricCard
                label="Client WiFi"
                value={wifiClients}
                hint={`${wifiOnline}/${wifi.length} AP online`}
                icon={<Ic d={ICON.wifi} />}
                tone="sky"
              />
            )}
          </div>
        )}

        <div className="space-y-6">
          {[...groups.entries()].map(([region, sitesIn]) => {
            const r = regionRollup(sitesIn);
            return (
              <section key={region}>
                <SectionHeader
                  title={region}
                  icon={<Ic d={ICON.factory} />}
                  tone="violet"
                  action={
                    <span className="flex items-center gap-2 text-xs text-slate-500">
                      <span>{sitesIn.length} pabrik</span>
                      {r.total > 0 && (
                        <>
                          <Badge tone="emerald">{r.up} up</Badge>
                          {r.down > 0 && <Badge tone="red">{r.down} down</Badge>}
                        </>
                      )}
                    </span>
                  }
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {sitesIn.map((s) => (
                    <SiteCard key={s.id} site={s} summary={summaryById.get(s.id)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </PageBody>
    </Page>
  );
}
