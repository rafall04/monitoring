'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Ticket, TicketStatus } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { liteInterval } from '@/lib/lite';
import { useSites } from '@/lib/queries';
import { useToast } from '@/lib/toast';
import {
  Badge,
  type Column,
  DataTable,
  Page,
  PageBody,
  PageHeader,
  Select,
  Toolbar,
} from '@/components/ui';

const STATUS_TONE: Record<TicketStatus, 'red' | 'amber' | 'emerald'> = {
  open: 'red',
  ack: 'amber',
  resolved: 'emerald',
};
const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  ack: 'Diproses',
  resolved: 'Selesai',
};

function timeAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

export default function TicketsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const sites = useSites();
  const canManage = can('tickets:manage');
  const [status, setStatus] = useState('');
  const [siteId, setSiteId] = useState('');

  const q = useQuery({
    queryKey: ['tickets', status, siteId],
    queryFn: () =>
      api.get<Ticket[]>(
        `/tickets${status || siteId ? '?' : ''}${status ? `status=${status}` : ''}${
          status && siteId ? '&' : ''
        }${siteId ? `siteId=${siteId}` : ''}`,
      ),
    refetchInterval: liteInterval(15_000),
  });

  const patch = useMutation({
    mutationFn: (v: { id: string; status: TicketStatus }) =>
      api.patch(`/tickets/${v.id}`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }),
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  const columns: ReadonlyArray<Column<Ticket>> = [
    {
      key: 'code',
      header: 'Tiket',
      cell: (r) => (
        <span className="font-mono text-xs font-semibold text-slate-200">
          #{r.id.slice(0, 6).toUpperCase()}
        </span>
      ),
      className: 'w-20',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
    },
    {
      key: 'reporter',
      header: 'Pelapor',
      cell: (r) => (
        <div>
          <div className="font-medium text-slate-100">
            {r.reporterName ?? 'Anonim'}
            {r.reporterDept ? <span className="text-slate-500"> · {r.reporterDept}</span> : null}
          </div>
          <div className="text-xs text-slate-500">
            {r.reporterPhone ?? 'via web'}
            {r.memberName ? ` · ${r.memberName}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'site', header: 'Site', cell: (r) => <span className="text-slate-400">{r.siteName ?? '—'}</span> },
    {
      key: 'message',
      header: 'Komplain',
      hideBelow: 'lg',
      cell: (r) => (
        <span className="block max-w-md truncate text-slate-300" title={r.message}>
          {r.message}
        </span>
      ),
    },
    {
      key: 'age',
      header: 'Umur',
      cell: (r) => (
        <div>
          <div>{timeAgo(r.createdAt)}</div>
          {r.handledBy && <div className="text-xs text-slate-500">oleh {r.handledBy}</div>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Aksi',
      align: 'right',
      label: null,
      cell: (r) =>
        canManage && r.status !== 'resolved' ? (
          <div className="flex justify-end gap-1.5 text-xs">
            {r.status === 'open' && (
              <button
                className="noc-tap inline-flex items-center rounded-md bg-amber-500/15 px-2 py-1 font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
                onClick={() => patch.mutate({ id: r.id, status: 'ack' })}
              >
                Proses
              </button>
            )}
            <button
              className="noc-tap inline-flex items-center rounded-md bg-emerald-500/15 px-2 py-1 font-medium text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
              onClick={() => patch.mutate({ id: r.id, status: 'resolved' })}
            >
              Selesai
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <Page>
      <PageHeader title="Tiket Komplain" subtitle="Komplain pelanggan dari bot WhatsApp." />
      <PageBody>
        <Toolbar
          left={
            <>
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
                <option value="">Semua status</option>
                <option value="open">Open</option>
                <option value="ack">Diproses</option>
                <option value="resolved">Selesai</option>
              </Select>
              <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} className="w-44">
                <option value="">Semua site</option>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </>
          }
          right={
            <span className="text-xs text-slate-500">
              Teknisi bisa balas PROSES/SELESAI &lt;kode&gt; dari WhatsApp.
            </span>
          }
        />
        <DataTable
          columns={columns}
          rows={q.data ?? []}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError}
          onRetry={() => void q.refetch()}
          empty={`Belum ada tiket${status || siteId ? ' dengan filter ini' : ''}.`}
        />
      </PageBody>
    </Page>
  );
}
