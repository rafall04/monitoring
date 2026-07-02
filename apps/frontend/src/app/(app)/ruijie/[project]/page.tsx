'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { RuijiePortDTO, RuijieRouterPublic } from '@noc/shared';
import {
  useRuijieFleetPorts,
  useRuijieRouterClients,
  useRuijieRouterPorts,
  useRuijieRouters,
} from '@/lib/queries';
import { Card, EmptyState, ErrorState, Loading, Page, PageBody, PageHeader } from '@/components/ui';

// Per-project detail: the access points of one Ruijie project (groupName) with
// an on-demand connected-client drill-down per AP. The whole fleet is already
// in cache from the overview, so we just filter — no extra fetch for the list.
export default function RuijieProjectPage() {
  const params = useParams<{ project: string }>();
  const raw = typeof params.project === 'string' ? params.project : '';
  const routers = useRuijieRouters();
  const [selected, setSelected] = useState<string | null>(null);

  // Match either the decoded name (Next decodes params) or the raw encoded form,
  // so the link is robust regardless of how the segment arrives.
  const list = (routers.data ?? []).filter(
    (r) => r.groupName === raw || encodeURIComponent(r.groupName) === raw,
  );
  const projectName = list[0]?.groupName ?? safeDecode(raw);
  const clients = list.reduce((n, r) => n + r.clientCount, 0);
  const online = list.filter((r) => r.online).length;
  // Uplink chip data: one cached per-SN call per online device on this page —
  // bounded by the project's size and shared with the drill-down panel's cache.
  const portMap = useRuijieFleetPorts(list.filter((r) => r.online).map((r) => r.id));

  return (
    <Page>
      <PageHeader
        title={projectName}
        subtitle={
          list.length
            ? `${online}/${list.length} AP online · ${clients} client terkoneksi`
            : 'Project Ruijie'
        }
        actions={
          <Link
            href="/ruijie"
            className="text-sm text-slate-400 hover:text-slate-200"
          >
            ← Semua project
          </Link>
        }
      />
      <PageBody width="wide">
        {routers.isError ? (
          <ErrorState onRetry={() => void routers.refetch()}>Gagal memuat data Ruijie.</ErrorState>
        ) : routers.isLoading ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState>
            Project tidak ditemukan atau belum dipantau.{' '}
            <Link href="/ruijie" className="text-accent hover:underline">
              Kembali ke daftar
            </Link>
            .
          </EmptyState>
        ) : (
          <Card className="p-0">
            <div className="divide-y divide-surface-border">
              {list.map((r) => (
                <RouterRow
                  key={r.id}
                  r={r}
                  ports={portMap[r.id]?.ports}
                  portsLoading={portMap[r.id]?.loading ?? false}
                  open={selected === r.id}
                  onToggle={() => setSelected((cur) => (cur === r.id ? null : r.id))}
                />
              ))}
            </div>
          </Card>
        )}
      </PageBody>
    </Page>
  );
}

function RouterRow({
  r,
  ports,
  portsLoading,
  open,
  onToggle,
}: {
  r: RuijieRouterPublic;
  ports: RuijiePortDTO[] | undefined;
  portsLoading: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface/40"
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${r.online ? 'bg-emerald-500' : 'bg-slate-500'}`}
          title={r.online ? 'online' : 'offline'}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-100">{r.name}</span>
          <span className="block truncate text-xs text-slate-500">
            {r.model ?? 'Reyee'} · {r.localIp ?? '—'}
            {r.mac ? ` · ${r.mac}` : ''}
          </span>
        </span>
        {r.online && <UplinkChip ports={ports} loading={portsLoading} />}
        <span className="shrink-0 text-right">
          <span className="text-lg font-semibold text-slate-100">{r.clientCount}</span>
          <span className="block text-[10px] text-slate-500">
            client{r.activeClients !== r.clientCount ? ` · ${r.activeClients} aktif` : ''}
          </span>
        </span>
        <span className="ml-1 shrink-0 text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <div className="px-3 sm:px-4">
            <PortPanel routerId={r.id} online={r.online} />
          </div>
          <ClientDrill routerId={r.id} online={r.online} count={r.clientCount} />
        </>
      )}
    </div>
  );
}

// ---- LAN/uplink port faceplate ----------------------------------------------

/** Tone for the negotiated speed: gigabit+ good, 100M attention, 10M bad. */
function speedTone(speed: string | null): string {
  const mbit = Number(/^([\d.]+)\s*M$/i.exec(speed ?? '')?.[1] ?? NaN);
  const gbit = /G$/i.test(speed ?? '');
  if (gbit || mbit >= 1000) return 'text-emerald-600 dark:text-emerald-400';
  if (mbit >= 100) return 'text-amber-600 dark:text-amber-400';
  if (mbit > 0) return 'text-rose-600 dark:text-rose-400';
  return 'text-slate-400';
}

function toMbit(speed: string | null): number {
  const m = /^([\d.]+)\s*(M|G)$/i.exec((speed ?? '').trim());
  if (!m) return 0;
  return Number(m[1]) * (m[2]!.toUpperCase() === 'G' ? 1000 : 1);
}
/** "1000M" → "1G" etc. — compact form for the row chip. */
function speedShort(speed: string | null): string {
  const mbit = toMbit(speed);
  if (mbit >= 1000) return `${Math.round((mbit / 1000) * 10) / 10}G`;
  if (mbit > 0) return `${mbit}M`;
  return speed ?? '';
}

/**
 * Compact wired-uplink summary on the row itself (no drill-down needed):
 * fastest up-port speed, plus up/total when the device is a multi-port switch.
 * All ports down is rendered neutrally — an AP uplinked via its WAN port
 * legitimately has every listed LAN port idle.
 */
function UplinkChip({ ports, loading }: { ports: RuijiePortDTO[] | undefined; loading: boolean }) {
  if (loading) {
    return <span className="h-5 w-14 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-500/20" />;
  }
  if (!ports || ports.length === 0) return null;
  const ups = ports.filter((p) => p.up);
  const top = ups.reduce<RuijiePortDTO | null>(
    (best, p) => (toMbit(p.speed) > toMbit(best?.speed ?? null) ? p : best),
    null,
  );
  const title = ports
    .map((p) => `${p.name} ${p.up ? `↑${p.speed ?? 'Up'}` : p.enabled ? 'down' : 'off'}`)
    .join(' · ');
  if (ups.length === 0) {
    return (
      <span
        title={title}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-500"
      >
        <JackIcon className="h-3 w-3 text-slate-400 dark:text-slate-600" /> LAN —
      </span>
    );
  }
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold"
    >
      <JackIcon className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      <span className={speedTone(top?.speed ?? null)}>↑{speedShort(top?.speed ?? null) || 'Up'}</span>
      {ports.length > 3 && (
        <span className="font-medium text-slate-500">{ups.length}/{ports.length}</span>
      )}
    </span>
  );
}

/** A tiny RJ45 jack pictogram (outline follows the port's link state color). */
function JackIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 5h14v10h-3.5v4h-7v-4H5z" />
      <path d="M9 5v3M12 5v3M15 5v3" strokeWidth="1.3" />
    </svg>
  );
}

function PortTile({ p }: { p: RuijiePortDTO }) {
  const label = p.up ? (p.speed ?? 'Up') : p.enabled ? '—' : 'off';
  const title = `${p.name} · ${p.up ? `Up${p.speed ? ` ${p.speed}` : ''}` : p.enabled ? 'Down' : 'Dinonaktifkan'}${p.medium ? ` · ${p.medium}` : ''}`;
  return (
    <div
      title={title}
      className={`flex w-[4.25rem] shrink-0 flex-col items-center gap-0.5 rounded-lg border px-1 py-2 transition ${
        p.up
          ? 'border-emerald-500/50 bg-emerald-500/10'
          : 'border-surface-border bg-surface/40'
      } ${p.enabled ? '' : 'opacity-50'}`}
    >
      <JackIcon className={p.up ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-600'} />
      <span
        className={`max-w-full truncate text-[10px] font-medium ${p.up ? 'text-slate-700 dark:text-slate-200' : 'text-slate-500'}`}
      >
        {p.name}
      </span>
      <span className={`text-[10px] font-semibold leading-none ${p.up ? speedTone(p.speed) : 'text-slate-500'}`}>
        {label}
      </span>
      {p.medium && p.medium.toLowerCase() !== 'copper' && (
        <span className="text-[9px] uppercase text-sky-600 dark:text-sky-400">{p.medium}</span>
      )}
    </div>
  );
}

/**
 * LAN port faceplate for one AP/switch — fetched ONCE on expand (per-SN call
 * against the shared Ruijie daily quota, so no auto-refresh); the header button
 * refreshes manually. A failed refresh keeps showing the last good tiles.
 */
function PortPanel({ routerId, online }: { routerId: string; online: boolean }) {
  const q = useRuijieRouterPorts(online ? routerId : null);
  const ports = q.data ?? [];
  const up = ports.filter((p) => p.up).length;
  return (
    <div className="mb-3 rounded-lg border border-surface-border bg-surface/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Port LAN (kabel)
        </span>
        <span className="flex items-center gap-2">
          {ports.length > 0 && (
            <span className={`text-[10px] font-medium ${up > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>
              {up}/{ports.length} link up
            </span>
          )}
          {online && (
            <button
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
              className="text-[10px] text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50 dark:hover:text-slate-300"
            >
              {q.isFetching ? 'Memuat…' : 'Segarkan'}
            </button>
          )}
        </span>
      </div>
      {!online ? (
        <p className="text-xs text-slate-500">Device offline — status port tidak bisa dibaca.</p>
      ) : q.isError && ports.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
          Gagal membaca port.
          <button
            onClick={() => void q.refetch()}
            className="underline hover:text-rose-400 dark:hover:text-rose-300"
          >
            Coba lagi
          </button>
        </div>
      ) : q.isLoading ? (
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[4.5rem] w-[4.25rem] animate-pulse rounded-lg bg-slate-200 dark:bg-slate-500/20" />
          ))}
        </div>
      ) : ports.length === 0 ? (
        <p className="text-xs text-slate-500">Data port tidak tersedia untuk model ini.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {ports.map((p) => (
              <PortTile key={`${p.port}-${p.name}`} p={p} />
            ))}
          </div>
          {q.isError && (
            <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
              Gagal menyegarkan — menampilkan data terakhir.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Connected-client list for one AP — fetched ONCE on expand (each read counts
 * against the shared Ruijie daily quota, so no auto-refresh); the header button
 * refreshes manually. A failed refresh keeps showing the last good list.
 */
function ClientDrill({ routerId, online, count }: { routerId: string; online: boolean; count: number }) {
  const q = useRuijieRouterClients(online && count > 0 ? routerId : null);
  if (!online || count === 0) {
    return <div className="px-4 pb-3 text-xs text-slate-500">Tidak ada client terkoneksi.</div>;
  }
  const clients = q.data ?? [];
  return (
    <div className="px-3 pb-3 sm:px-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Client terkoneksi
        </span>
        <button
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          className="text-[10px] text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50 dark:hover:text-slate-300"
        >
          {q.isFetching ? 'Memuat…' : 'Segarkan'}
        </button>
      </div>
      {q.isError && clients.length === 0 ? (
        <ErrorState onRetry={() => void q.refetch()}>Gagal memuat daftar client.</ErrorState>
      ) : q.isLoading ? (
        <Loading />
      ) : clients.length === 0 ? (
        <p className="py-2 text-xs text-slate-500">Detail client tidak tersedia.</p>
      ) : (
        // Responsive list (not a wide table) so it stays tidy on a phone: each
        // client wraps to its own lines on narrow screens, one row on desktop.
        <>
          <ul className="divide-y divide-surface-border overflow-hidden rounded-md border border-surface-border">
            {clients.map((s) => (
              <li key={s.mac} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="text-sm font-medium text-slate-100">{s.hostname ?? s.os ?? '?'}</span>
                {s.band && (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-slate-400">
                    {s.band}
                    {s.rssi != null ? ` · ${s.rssi}dBm` : ''}
                  </span>
                )}
                {s.ssid && <span className="truncate text-xs text-slate-500">{s.ssid}</span>}
                {s.apName && <span className="text-[10px] text-slate-500">via {s.apName}</span>}
                <span className="ml-auto text-right text-xs leading-tight text-slate-400">
                  <span className="block">{s.ip ?? '—'}</span>
                  <span className="block font-mono text-[10px] text-slate-500">{s.mac}</span>
                </span>
              </li>
            ))}
          </ul>
          {q.isError && (
            <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
              Gagal menyegarkan — menampilkan data terakhir.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
