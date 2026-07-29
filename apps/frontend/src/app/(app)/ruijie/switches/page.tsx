'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { RuijiePortDTO, RuijieRouterPublic } from '@noc/shared';
import { useRuijieFleetPorts, useRuijiePortHealth, useRuijieRouters } from '@/lib/queries';
import { isRuijieSwitch, PortTile } from '@/components/ruijie-ports';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  MetricCard,
  Page,
  PageBody,
  PageHeader,
} from '@/components/ui';

// Dedicated switch board: every managed Ruijie switch (ES208GC …) with its full
// LAN port faceplate, degraded ports flagged from the worker's health data (our
// DB, 0 Ruijie calls). Port faceplates use the shared per-SN cache — one cached
// call per online switch, reused by the project pages.
export default function RuijieSwitchesPage() {
  const routers = useRuijieRouters();
  const health = useRuijiePortHealth();

  const switches = useMemo(
    () =>
      (routers.data ?? [])
        .filter((r) => isRuijieSwitch(r.model))
        .sort((a, b) => a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name)),
    [routers.data],
  );
  const onlineIds = switches.filter((r) => r.online).map((r) => r.id);
  const portMap = useRuijieFleetPorts(onlineIds);

  // Per-switch problem ports from the (DB-backed) health board.
  const issues = useMemo(() => {
    const m = new Map<string, { degraded: Set<string>; flaps: number }>();
    for (const row of health.data?.rows ?? []) {
      const e = m.get(row.routerId) ?? { degraded: new Set<string>(), flaps: 0 };
      if (row.degraded) e.degraded.add(row.portName);
      e.flaps += row.flaps1h;
      m.set(row.routerId, e);
    }
    return m;
  }, [health.data]);

  const online = switches.filter((r) => r.online).length;
  const { portsUp, portsTotal } = useMemo(() => {
    let up = 0;
    let total = 0;
    for (const id of onlineIds) {
      const ps = portMap[id]?.ports ?? [];
      total += ps.length;
      up += ps.filter((p) => p.up).length;
    }
    return { portsUp: up, portsTotal: total };
  }, [portMap, onlineIds]);
  const switchIds = new Set(switches.map((r) => r.id));
  const degradedPorts = (health.data?.rows ?? []).filter((r) => switchIds.has(r.routerId) && r.degraded).length;

  return (
    <Page>
      <PageHeader
        title="Switch"
        subtitle={
          switches.length
            ? `${online}/${switches.length} switch online · ${portsUp}/${portsTotal} port link up`
            : 'Switch Ruijie terkelola'
        }
        actions={
          <Link href="/ruijie" className="noc-tap inline-flex items-center text-sm text-slate-400 hover:text-slate-200">
            ← Ruijie WiFi
          </Link>
        }
      />
      <PageBody width="wide">
        {routers.isError ? (
          <ErrorState onRetry={() => void routers.refetch()}>Gagal memuat data Ruijie.</ErrorState>
        ) : routers.isLoading ? (
          <Loading />
        ) : switches.length === 0 ? (
          <EmptyState>Tidak ada switch Ruijie pada project yang dipantau.</EmptyState>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard label="Switch" value={switches.length} tone="sky" icon={<SwitchIcon />} />
              <MetricCard label="Online" value={`${online}/${switches.length}`} tone={online === switches.length ? 'emerald' : 'amber'} />
              <MetricCard label="Port link up" value={portsTotal ? `${portsUp}/${portsTotal}` : '—'} tone="violet" />
              <MetricCard
                label="Port lambat"
                value={degradedPorts}
                tone={degradedPorts > 0 ? 'red' : 'slate'}
              />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {switches.map((s) => (
                <SwitchCard
                  key={s.id}
                  s={s}
                  ports={portMap[s.id]?.ports}
                  loading={portMap[s.id]?.loading ?? false}
                  degraded={issues.get(s.id)?.degraded ?? EMPTY}
                  flaps={issues.get(s.id)?.flaps ?? 0}
                />
              ))}
            </div>
          </>
        )}
      </PageBody>
    </Page>
  );
}

const EMPTY = new Set<string>();

function SwitchCard({
  s,
  ports,
  loading,
  degraded,
  flaps,
}: {
  s: RuijieRouterPublic;
  ports: RuijiePortDTO[] | undefined;
  loading: boolean;
  degraded: Set<string>;
  flaps: number;
}) {
  const up = (ports ?? []).filter((p) => p.up).length;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-start gap-3">
        <span
          className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${s.online ? 'bg-emerald-500' : 'bg-slate-500'}`}
          title={s.online ? 'online' : 'offline'}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-100" title={s.name}>
            {s.name}
          </div>
          <div className="truncate text-xs text-slate-500">
            {s.model ?? 'Switch'} · {s.groupName}
            {s.localIp ? ` · ${s.localIp}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {degraded.size > 0 ? (
            <Badge tone="red">{degraded.size} port lambat</Badge>
          ) : flaps > 0 ? (
            <Badge tone="amber">flapping {flaps}×</Badge>
          ) : (
            ports &&
            ports.length > 0 && (
              <span className="text-micro font-medium text-emerald-600 dark:text-emerald-400">{up}/{ports.length} up</span>
            )
          )}
          <Link
            href={`/ruijie/${encodeURIComponent(s.groupName)}`}
            className="noc-tap inline-flex items-center text-micro text-slate-500 hover:text-slate-300"
          >
            detail →
          </Link>
        </div>
      </div>

      {!s.online ? (
        <p className="text-xs text-slate-500">Switch offline — status port tidak bisa dibaca.</p>
      ) : loading ? (
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="h-[4.5rem] w-[4.25rem] animate-pulse rounded-lg bg-slate-200 dark:bg-slate-500/20" />
          ))}
        </div>
      ) : !ports || ports.length === 0 ? (
        <p className="text-xs text-slate-500">Data port belum tersedia.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ports.map((p) => (
            <PortTile key={`${p.port}-${p.name}`} p={p} flagged={degraded.has(p.name)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function SwitchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="9" width="20" height="6" rx="1.5" />
      <path d="M6 15v2M10 15v2M14 15v2M18 15v2M6 12h.01" />
    </svg>
  );
}
