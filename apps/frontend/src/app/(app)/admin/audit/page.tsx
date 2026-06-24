'use client';

import { Fragment, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useAuditLog } from '@/lib/queries';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Page,
  PageBody,
  PageHeader,
  Select,
} from '@/components/ui';

const PAGE_SIZE = 50;

// Audit trail viewer — who did what, when. Reads the history every sensitive
// mutation writes via writeAudit(). super_admin only (audit:view).
export default function AuditPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const allowed = can('audit:view');
  const q = useAuditLog(
    { page, pageSize: PAGE_SIZE, entity: entity || undefined, action: action || undefined },
    allowed,
  );

  if (!allowed) {
    return (
      <Page>
        <PageHeader title="Aktivitas" subtitle="Log audit sistem." />
        <PageBody>
          <EmptyState>Khusus super admin.</EmptyState>
        </PageBody>
      </Page>
    );
  }

  const data = q.data;
  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const onFilter = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(1);
  };

  return (
    <Page>
      <PageHeader
        title="Aktivitas"
        subtitle={data ? `${data.total} entri · jejak aktivitas admin & operator` : 'Jejak audit sistem'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={entity}
              onChange={(e) => onFilter(setEntity)(e.target.value)}
              className="w-36"
            >
              <option value="">Semua entity</option>
              {data?.facets.entities.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <Select
              value={action}
              onChange={(e) => onFilter(setAction)(e.target.value)}
              className="w-44"
            >
              <option value="">Semua aksi</option>
              {data?.facets.actions.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      <PageBody width="wide">
        {q.isError ? (
          <ErrorState onRetry={() => void q.refetch()}>Gagal memuat log audit.</ErrorState>
        ) : q.isLoading ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyState>Tidak ada aktivitas{entity || action ? ' untuk filter ini' : ''}.</EmptyState>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="r-table w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr className="border-b border-surface-border">
                  <th className="px-4 py-2">Waktu</th>
                  <th className="px-2">Pelaku</th>
                  <th className="px-2">Aksi</th>
                  <th className="px-2">Entity</th>
                  <th className="px-2">IP</th>
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => {
                  const hasDetail = a.before != null || a.after != null;
                  return (
                    <Fragment key={a.id}>
                      <tr className="border-t border-surface-border align-top">
                        <td data-label="Waktu" className="whitespace-nowrap px-4 py-2 text-slate-300">
                          {fmt(a.createdAt)}
                        </td>
                        <td data-label="Pelaku" className="px-2 py-2">
                          {a.user ? (
                            <span className="text-slate-100">
                              {a.user.name}{' '}
                              <span className="text-[10px] text-slate-500">({a.user.role})</span>
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td data-label="Aksi" className="px-2 py-2">
                          <ActionPill action={a.action} />
                        </td>
                        <td data-label="Entity" className="px-2 py-2 text-slate-300">
                          {a.entity}
                          {a.entityId && (
                            <span className="ml-1 font-mono text-[10px] text-slate-500">
                              {a.entityId.slice(0, 8)}
                            </span>
                          )}
                        </td>
                        <td data-label="IP" className="px-2 py-2 font-mono text-xs text-slate-500">
                          {a.ip ?? '—'}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {hasDetail && (
                            <button
                              className="text-accent hover:opacity-80"
                              onClick={() => setOpenId((c) => (c === a.id ? null : a.id))}
                            >
                              {openId === a.id ? 'tutup' : 'detail'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {openId === a.id && hasDetail && (
                        <tr className="border-t border-surface-border bg-surface/40">
                          <td colSpan={6} className="px-4 py-3">
                            <div className="grid gap-3 sm:grid-cols-2">
                              {a.before != null && <JsonBlock label="Sebelum" value={a.before} />}
                              {a.after != null && <JsonBlock label="Sesudah" value={a.after} />}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        {data && totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-slate-400">
            <span>
              Halaman {data.page} / {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                ← Sebelumnya
              </Button>
              <Button
                variant="secondary"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages}
              >
                Berikutnya →
              </Button>
            </div>
          </div>
        )}
      </PageBody>
    </Page>
  );
}

function ActionPill({ action }: { action: string }) {
  const danger = /delete|unack/.test(action);
  const create = /create/.test(action);
  const cls = danger
    ? 'bg-red-500/15 text-red-400'
    : create
      ? 'bg-emerald-500/15 text-emerald-400'
      : 'bg-slate-500/15 text-slate-300';
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{action}</span>;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <pre className="overflow-x-auto rounded bg-surface p-2 text-[11px] leading-snug text-slate-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
