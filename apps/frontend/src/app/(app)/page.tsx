'use client';

import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import type { Site, SiteSummary } from '@noc/shared';
import { api } from '@/lib/api';
import { qk, useSites } from '@/lib/queries';
import { Card, ErrorState, Loading, Page, PageBody, PageHeader, Spinner } from '@/components/ui';

function SiteCard({ site, summary }: { site: Site; summary?: SiteSummary }) {
  const s = summary;
  return (
    <Link href={`/sites/${site.id}`}>
      <Card className="p-4 transition hover:border-blue-600">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-slate-100">{site.name}</h3>
          <span className="text-xs text-slate-500">
            {site.mapMode === 'geo' ? 'geo' : 'floorplan'}
          </span>
        </div>
        {s ? (
          <>
            <div className="mt-3 flex gap-4 text-sm">
              <span className="text-emerald-400">{s.up} up</span>
              <span className="text-red-400">{s.down} down</span>
              <span className="text-slate-400">{s.unknown} unknown</span>
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
                  <li className="text-slate-500">+{s.currentlyDown.length - 4} more…</li>
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

  // Group factories by kabupaten (region).
  const groups = new Map<string, Site[]>();
  for (const s of list) {
    const key = s.region?.trim() || 'Tanpa kabupaten';
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

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
      <PageHeader title="Overview" subtitle="Status across all sites you can access." />
      <PageBody>
        {sites.isLoading && <Loading />}
        {sites.isError && (
          <ErrorState onRetry={() => void sites.refetch()}>Gagal memuat daftar site.</ErrorState>
        )}
        {!sites.isLoading && !sites.isError && list.length === 0 && (
          <p className="text-slate-400">No sites assigned. Ask an admin to grant access.</p>
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
