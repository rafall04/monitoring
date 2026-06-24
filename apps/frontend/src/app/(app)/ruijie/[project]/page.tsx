'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { RuijieRouterPublic } from '@noc/shared';
import { useRuijieRouterClients, useRuijieRouters } from '@/lib/queries';
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

function RouterRow({ r, open, onToggle }: { r: RuijieRouterPublic; open: boolean; onToggle: () => void }) {
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
        <span className="shrink-0 text-right">
          <span className="text-lg font-semibold text-slate-100">{r.clientCount}</span>
          <span className="block text-[10px] text-slate-500">
            client{r.activeClients !== r.clientCount ? ` · ${r.activeClients} aktif` : ''}
          </span>
        </span>
        <span className="ml-1 shrink-0 text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && <ClientDrill routerId={r.id} online={r.online} count={r.clientCount} />}
    </div>
  );
}

function ClientDrill({ routerId, online, count }: { routerId: string; online: boolean; count: number }) {
  const q = useRuijieRouterClients(online && count > 0 ? routerId : null);
  if (!online || count === 0) {
    return <div className="px-4 pb-3 text-xs text-slate-500">Tidak ada client terkoneksi.</div>;
  }
  const clients = q.data ?? [];
  return (
    <div className="px-3 pb-3 sm:px-4">
      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()}>Gagal memuat daftar client.</ErrorState>
      ) : q.isLoading ? (
        <Loading />
      ) : clients.length === 0 ? (
        <p className="py-2 text-xs text-slate-500">Detail client tidak tersedia.</p>
      ) : (
        // Responsive list (not a wide table) so it stays tidy on a phone: each
        // client wraps to its own lines on narrow screens, one row on desktop.
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
