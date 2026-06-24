'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Site, SiteSummary } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { qk, useRuijieRouters, useSites } from '@/lib/queries';
import { Card, ErrorState, Loading, Page, PageBody, PageHeader, Spinner } from '@/components/ui';

type Tone = 'up' | 'down' | 'unknown' | 'accent' | 'default';

function Kpi({ label, value, sub, tone = 'default' }: { label: string; value: ReactNode; sub?: string; tone?: Tone }) {
  const color =
    tone === 'up'
      ? 'text-emerald-400'
      : tone === 'down'
        ? 'text-red-400'
        : tone === 'unknown'
          ? 'text-slate-400'
          : tone === 'accent'
            ? 'text-accent'
            : 'text-slate-100';
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold leading-none ${color}`}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-slate-500">{sub}</div>}
    </Card>
  );
}

function SiteCard({ site, summary }: { site: Site; summary?: SiteSummary }) {
  const s = summary;
  return (
    <Link href={`/sites/${site.id}`}>
      <Card className="p-4 transition hover:border-accent/60 hover:bg-surface/30">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate font-semibold text-slate-100">{site.name}</h3>
          <span className="shrink-0 text-xs text-slate-500">
            {site.mapMode === 'geo' ? 'geo' : 'denah'}
          </span>
        </div>
        {s ? (
          <>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span className="text-emerald-400">{s.up} up</span>
              <span className="text-red-400">{s.down} down</span>
              <span className="text-slate-400">{s.unknown} ?</span>
              {s.maintenance > 0 && <span className="text-blue-400">{s.maintenance} mnt</span>}
            </div>
            <div className="mt-2 text-2xl font-semibold text-slate-100">
              {s.availabilityPct}
              <span className="text-base text-slate-500">% avail</span>
            </div>
            {s.currentlyDown.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-red-300">
                {s.currentlyDown.slice(0, 4).map((d) => (
                  <li key={d.deviceId}>● {d.name}</li>
                ))}
                {s.currentlyDown.length > 4 && (
                  <li className="text-slate-500">+{s.currentlyDown.length - 4} lagi…</li>
                )}
              </ul>
            )}
          </>
        ) : (
          <div className="mt-3">
            <Spinner />
          </div>
        )}
      </Card>
    </Link>
  );
}

export default function OverviewPage() {
  const { can } = useAuth();
  const sites = useSites();
  const list = sites.data ?? [];

  // Fetch every site's summary so we can show per-factory cards AND per-region
  // rollups. This page has no per-site WebSocket subscription, so poll on an
  // interval to keep the overview counts from going stale.
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

  // Ruijie WiFi rollup (only for roles that can see it).
  const ruijie = useRuijieRouters(can('ruijie:view'));
  const wifi = ruijie.data ?? [];
  const wifiClients = wifi.reduce((n, r) => n + r.clientCount, 0);
  const wifiOnline = wifi.filter((r) => r.online).length;

  // Group factories by kabupaten (region).
  const groups = new Map<string, Site[]>();
  for (const s of list) {
    const key = s.region?.trim() || 'Tanpa kabupaten';
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  // Global rollup across every accessible site.
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
            <Kpi label="Availability" value={`${availability}%`} sub={`${monitored} dipantau`} tone={agg.down > 0 ? 'down' : 'up'} />
            <Kpi label="Perangkat up" value={agg.up} tone="up" />
            <Kpi label="Down" value={agg.down} tone="down" sub={agg.down > 0 ? 'perlu perhatian' : 'aman'} />
            <Kpi label="Tidak diketahui" value={agg.unknown} tone="unknown" />
            <Kpi label="Pabrik" value={list.length} sub={`${groups.size} kabupaten`} />
            {can('ruijie:view') && (
              <Kpi label="Client WiFi" value={wifiClients} sub={`${wifiOnline}/${wifi.length} AP online`} tone="accent" />
            )}
          </div>
        )}

        <div className="space-y-6">
          {[...groups.entries()].map(([region, sitesIn]) => {
            const r = regionRollup(sitesIn);
            return (
              <section key={region}>
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                    {region}
                  </h2>
                  <span className="text-xs text-slate-500">{sitesIn.length} pabrik</span>
                  {r.total > 0 && (
                    <span className="text-xs">
                      <span className="text-emerald-400">{r.up} up</span>
                      {r.down > 0 && <span className="text-red-400"> · {r.down} down</span>}
                      <span className="text-slate-500"> / {r.total}</span>
                    </span>
                  )}
                </div>
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
