'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { RuijiePortHealthRow, RuijieRouterPublic } from '@noc/shared';
import { useAuth } from '@/lib/auth';
import { useRuijiePortHealth, useRuijieRouters } from '@/lib/queries';
import { Card, EmptyState, ErrorState, Loading, Page, PageBody, PageHeader } from '@/components/ui';

/** 1000 → "1G", 2500 → "2.5G", 100 → "100M", 0 → "—". */
function fmtMbit(mbit: number): string {
  if (mbit <= 0) return '—';
  if (mbit >= 1000) return `${Math.round((mbit / 1000) * 10) / 10}G`;
  return `${mbit}M`;
}

function shortAgo(iso: string | null): string {
  if (!iso) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}d lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m lalu`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}j lalu`;
  return `${Math.floor(h / 24)}h lalu`;
}

// Ruijie WiFi — monitoring overview. One card per monitored project (grouped by
// Ruijie Cloud groupName); click a card to drill into its access points and
// connected clients at /ruijie/<project>. Account management lives separately at
// /admin/ruijie so this view stays clean of credential forms.
export default function RuijiePage() {
  const { can } = useAuth();
  const routers = useRuijieRouters();

  const list = routers.data ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, RuijieRouterPublic[]>();
    for (const r of list) m.set(r.groupName, [...(m.get(r.groupName) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);
  const totalClients = list.reduce((n, r) => n + r.clientCount, 0);
  const online = list.filter((r) => r.online).length;

  return (
    <Page>
      <PageHeader
        title="Ruijie WiFi"
        subtitle={
          list.length
            ? `${groups.length} project · ${online}/${list.length} AP online · ${totalClients} client terkoneksi`
            : 'Status & jumlah client per project'
        }
        actions={
          <Link
            href="/ruijie/switches"
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface/60 px-3 py-1.5 text-sm text-slate-300 transition hover:border-accent/60 hover:text-slate-100"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="2" y="9" width="20" height="6" rx="1.5" />
              <path d="M6 15v2M10 15v2M14 15v2M18 15v2" />
            </svg>
            Switch
          </Link>
        }
      />
      <PageBody width="wide">
        <PortHealthBoard />
        {routers.isError ? (
          <ErrorState onRetry={() => void routers.refetch()}>Gagal memuat data Ruijie.</ErrorState>
        ) : routers.isLoading ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState>
            Belum ada project dipantau.{' '}
            {can('ruijie:manage') ? (
              <>
                Buka{' '}
                <Link href="/admin/ruijie" className="text-accent hover:underline">
                  Ruijie Cloud
                </Link>{' '}
                untuk menambah akun &amp; memilih project.
              </>
            ) : (
              'Minta admin menambahkan akun Ruijie Cloud.'
            )}
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map(([name, rs]) => (
              <ProjectCard key={name} name={name} routers={rs} />
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  );
}

/**
 * Fleet-wide port health — the payoff board. Surfaces links that are UP but
 * running below their learned baseline (the silent slowdown that ping/Netwatch
 * miss) plus flapping ports, worst-first. Reads OUR DB (0 Ruijie calls) so it
 * stays live. Hidden until the worker's port poller has produced data.
 */
function PortHealthBoard() {
  const q = useRuijiePortHealth();
  const data = q.data;
  if (!data || data.summary.monitoredPorts === 0) return null;
  const { summary, rows } = data;

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-100">Kesehatan Port LAN</h2>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          {summary.degraded > 0 && (
            <span className="rounded-full bg-rose-500/15 px-2 py-0.5 font-semibold text-rose-400">
              {summary.degraded} lambat
            </span>
          )}
          {summary.flapping > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-400">
              {summary.flapping} flapping
            </span>
          )}
          <span className="text-slate-500">
            {summary.monitoredPorts} port · {shortAgo(summary.lastPolledAt)}
          </span>
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
          Semua port pada kecepatan normal.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <PortHealthRow key={`${r.routerId}:${r.portName}`} r={r} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PortHealthRow({ r }: { r: RuijiePortHealthRow }) {
  const detail = r.degraded
    ? `turun ke ${fmtMbit(r.speedMbit)} · normal ${fmtMbit(r.baselineMbit)}`
    : `flapping ${r.flaps1h}× / jam`;
  return (
    <li>
      <Link
        href={`/ruijie/${encodeURIComponent(r.groupName)}`}
        className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface/30 px-3 py-2 transition hover:border-accent/60 hover:bg-surface/50"
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${r.degraded ? 'bg-rose-500' : 'bg-amber-500'}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-slate-100">
            {r.routerName} · <span className="font-mono text-slate-300">{r.portName}</span>
          </span>
          <span className="block truncate text-xs text-slate-500">{r.groupName}</span>
        </span>
        <span
          className={`shrink-0 text-right text-xs font-medium ${r.degraded ? 'text-rose-400' : 'text-amber-400'}`}
        >
          {detail}
        </span>
        <span className="shrink-0 text-slate-600">→</span>
      </Link>
    </li>
  );
}

function ProjectCard({ name, routers }: { name: string; routers: RuijieRouterPublic[] }) {
  const clients = routers.reduce((n, r) => n + r.clientCount, 0);
  const online = routers.filter((r) => r.online).length;
  const allOnline = online === routers.length;
  return (
    <Link href={`/ruijie/${encodeURIComponent(name)}`} className="group block">
      <Card className="h-full p-4 transition hover:border-accent/60 hover:bg-surface/40">
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 flex-1 truncate font-semibold text-slate-100" title={name}>
            {name}
          </h2>
          <span className="shrink-0 text-slate-500 transition group-hover:translate-x-0.5">→</span>
        </div>
        <div className="mt-3 flex items-end justify-between gap-2">
          <div>
            <div className="text-3xl font-semibold leading-none text-slate-100">{clients}</div>
            <div className="mt-1 text-xs text-slate-500">client terkoneksi</div>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
              allOnline ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${allOnline ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {online}/{routers.length} AP
          </span>
        </div>
      </Card>
    </Link>
  );
}
