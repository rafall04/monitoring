'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditLogRow, Incident, StatusEventRow } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  Badge,
  Card,
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  Loading,
  Page,
  PageBody,
  PageHeader,
  Select,
  Tabs,
  Toolbar,
} from '@/components/ui';

type Tab = 'open' | 'timeline' | 'audit';

export default function AlertsPage() {
  const { can } = useAuth();
  const canAck = can('alerts:manage');
  const canAudit = can('audit:view');
  const [tab, setTab] = useState<Tab>('open');

  const tabs: { value: Tab; label: string }[] = [
    { value: 'open', label: 'Open incidents' },
    { value: 'timeline', label: 'Event timeline' },
    ...(canAudit ? [{ value: 'audit' as Tab, label: 'Audit log' }] : []),
  ];

  return (
    <Page>
      <PageHeader
        title="Alerts & Incidents"
        subtitle="Pusat insiden, timeline event, dan audit log."
        actions={<Tabs tabs={tabs} value={tab} onChange={setTab} />}
      />
      <PageBody>
        {tab === 'open' && <OpenIncidents canAck={canAck} />}
        {tab === 'timeline' && <EventTimeline />}
        {tab === 'audit' && canAudit && <AuditLog />}
      </PageBody>
    </Page>
  );
}

// ============================================================================
// Tab 1 — Open incidents (currently-down devices, with ack + silence actions).
// ============================================================================

function OpenIncidents({ canAck }: { canAck: boolean }) {
  const qc = useQueryClient();
  const [criticalOnly, setCriticalOnly] = useState(false);
  const q = useQuery({
    queryKey: ['incidents', criticalOnly],
    queryFn: () =>
      api.get<Incident[]>(`/alerts/incidents${criticalOnly ? '?critical=1' : ''}`),
    refetchInterval: 10_000,
  });

  const ack = useMutation({
    mutationFn: (deviceId: string) => api.post(`/alerts/incidents/${deviceId}/ack`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incidents'] }),
  });
  const unack = useMutation({
    mutationFn: (deviceId: string) => api.post(`/alerts/incidents/${deviceId}/unack`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incidents'] }),
  });
  const silence = useMutation({
    mutationFn: (v: { deviceId: string; minutes: number }) =>
      api.post(`/alerts/incidents/${v.deviceId}/silence`, { minutes: v.minutes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incidents'] }),
  });

  if (q.isError)
    return (
      <ErrorState onRetry={() => void q.refetch()}>
        Gagal memuat insiden — jangan anggap aman. Coba lagi.
      </ErrorState>
    );
  if (q.isLoading) return <Loading />;
  const rows = q.data ?? [];
  const critical = rows.filter((r) => r.isCritical).length;

  const columns: ReadonlyArray<Column<Incident>> = [
    {
      key: 'dot',
      header: '',
      label: null,
      cell: (r) => (
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            r.isCritical ? 'bg-amber-400' : 'bg-red-500'
          }`}
          title={r.isCritical ? 'critical' : 'down'}
        />
      ),
      className: 'w-6',
    },
    {
      key: 'device',
      header: 'Device',
      cell: (r) => <span className="font-medium text-slate-100">{r.deviceName}</span>,
    },
    { key: 'site', header: 'Site', cell: (r) => <span className="text-slate-400">{r.siteName}</span> },
    { key: 'down', header: 'Down for', cell: (r) => formatDuration(r.durationSec) },
    {
      key: 'ack',
      header: 'Ack',
      hideBelow: 'lg',
      cell: (r) =>
        r.ackBy ? (
          <span className="text-xs text-emerald-400">
            ✓ {r.ackBy}
            {r.ackAt && <span className="text-slate-500"> · {timeAgo(r.ackAt)}</span>}
          </span>
        ) : (
          <span className="text-slate-500">—</span>
        ),
    },
    {
      key: 'silence',
      header: 'Silence',
      hideBelow: 'xl',
      cell: (r) =>
        r.silencedUntil ? (
          <span className="text-xs text-amber-400">
            until {new Date(r.silencedUntil).toLocaleString()}
          </span>
        ) : (
          <span className="text-slate-500">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      label: null,
      cell: (r) =>
        canAck ? (
          <div className="flex justify-end gap-1.5 text-xs">
            {r.ackBy ? (
              <button
                className="noc-tap inline-flex items-center text-slate-400 hover:text-slate-200"
                onClick={() => unack.mutate(r.deviceId)}
              >
                unack
              </button>
            ) : (
              <button
                className="noc-tap inline-flex items-center rounded-md bg-emerald-500/15 px-2 py-1 font-medium text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
                onClick={() => ack.mutate(r.deviceId)}
              >
                Acknowledge
              </button>
            )}
            <SilenceMenu
              silenced={!!r.silencedUntil}
              onPick={(minutes) => silence.mutate({ deviceId: r.deviceId, minutes })}
            />
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <Toolbar
        left={
          <>
            <Badge tone="red">{rows.length} open</Badge>
            {critical > 0 && <Badge tone="amber">{critical} critical</Badge>}
          </>
        }
        right={
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={criticalOnly}
              onChange={(e) => setCriticalOnly(e.target.checked)}
            />
            critical only
          </label>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.deviceId}
        empty="Tidak ada insiden terbuka. 🎉"
      />

      <p className="text-2xs text-slate-500">
        Auto-refresh tiap 10 detik. Maintenance window (manual override) tidak
        tampil di sini.
      </p>
    </div>
  );
}

function SilenceMenu({
  silenced,
  onPick,
}: {
  silenced: boolean;
  onPick: (minutes: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        className={`noc-tap inline-flex items-center rounded px-2 py-1 ${
          silenced ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:text-slate-200'
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        {silenced ? 'Silenced…' : 'Silence'}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-32 rounded border border-surface-border bg-surface-raised shadow-lg">
          {[15, 60, 240, 1440].map((m) => (
            <button
              key={m}
              className="noc-tap flex w-full items-center px-3 py-1 text-left text-xs hover:bg-slate-800"
              onClick={() => {
                onPick(m);
                setOpen(false);
              }}
            >
              {m < 60 ? `${m} min` : m === 60 ? '1 hour' : m === 240 ? '4 hours' : '1 day'}
            </button>
          ))}
          {silenced && (
            <button
              className="noc-tap flex w-full items-center border-t border-surface-border px-3 py-1 text-left text-xs text-red-400 hover:bg-slate-800"
              onClick={() => {
                onPick(0);
                setOpen(false);
              }}
            >
              Unsilence
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Tab 2 — Status-event timeline.
// ============================================================================

function EventTimeline() {
  const [filterStatus, setFilterStatus] = useState<'' | 'down' | 'up' | 'unknown'>('');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const qs = new URLSearchParams();
  qs.set('limit', '100');
  if (filterStatus) qs.set('newStatus', filterStatus);
  if (criticalOnly) qs.set('critical', '1');

  const q = useQuery({
    queryKey: ['events', filterStatus, criticalOnly],
    queryFn: () =>
      api.get<{ events: StatusEventRow[]; nextCursor: string | null }>(
        `/alerts/events?${qs.toString()}`,
      ),
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-4">
      <Toolbar
        left={
          <>
            <span className="text-xs text-slate-400">Status</span>
            <Select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
              className="w-28"
            >
              <option value="">all</option>
              <option value="down">down</option>
              <option value="up">up</option>
              <option value="unknown">unknown</option>
            </Select>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={criticalOnly}
                onChange={(e) => setCriticalOnly(e.target.checked)}
              />
              critical only
            </label>
          </>
        }
      />

      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()}>Gagal memuat event.</ErrorState>
      ) : q.isLoading ? (
        <Loading />
      ) : (q.data?.events.length ?? 0) === 0 ? (
        <EmptyState>Belum ada event.</EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-surface-border">
            {q.data?.events.map((e) => (
              // Wraps into two lines on phones instead of scrolling sideways:
              // identity first, transition + timestamp second.
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm"
              >
                <StatusDot s={e.newStatus} />
                <span className="font-medium text-slate-100">{e.deviceName}</span>
                {e.isCritical && <Badge tone="amber">critical</Badge>}
                <span className="text-slate-400">@ {e.siteName}</span>
                <span className="w-full text-xs text-slate-500 sm:ml-auto sm:w-auto sm:text-right">
                  {e.oldStatus} → <span className={statusColor(e.newStatus)}>{e.newStatus}</span>
                  <span className="ml-1">· {e.source}</span>
                  <span className="ml-2">{new Date(e.occurredAt).toLocaleString()}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ============================================================================
// Tab 3 — Audit log.
// ============================================================================

function AuditLog() {
  const [entity, setEntity] = useState('');
  const qs = new URLSearchParams();
  qs.set('limit', '100');
  if (entity) qs.set('entity', entity);

  const q = useQuery({
    queryKey: ['audit', entity],
    queryFn: () =>
      api.get<{ logs: AuditLogRow[]; nextCursor: string | null }>(
        `/alerts/audit?${qs.toString()}`,
      ),
  });

  const entities = ['', 'device', 'router', 'site', 'app_user', 'setting', 'incident'];

  return (
    <div className="space-y-4">
      <Toolbar
        left={
          <>
            <span className="text-xs text-slate-400">Entity</span>
            <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-36">
              {entities.map((e) => (
                <option key={e || 'all'} value={e}>
                  {e || 'all'}
                </option>
              ))}
            </Select>
          </>
        }
      />

      <DataTable
        columns={AUDIT_COLUMNS}
        rows={q.data?.logs ?? []}
        rowKey={(l) => l.id}
        loading={q.isLoading}
        error={q.isError}
        onRetry={() => void q.refetch()}
        empty="Tidak ada entri."
        dense
      />
    </div>
  );
}

const AUDIT_COLUMNS: ReadonlyArray<Column<AuditLogRow>> = [
  {
    key: 'when',
    header: 'When',
    cell: (l) => (
      <span className="text-xs text-slate-400">{new Date(l.createdAt).toLocaleString()}</span>
    ),
  },
  { key: 'user', header: 'User', cell: (l) => <span className="text-slate-300">{l.userName ?? '—'}</span> },
  {
    key: 'action',
    header: 'Action',
    cell: (l) => <span className="font-medium text-slate-100">{l.action}</span>,
  },
  { key: 'entity', header: 'Entity', cell: (l) => <span className="text-slate-400">{l.entity}</span> },
  {
    key: 'id',
    header: 'ID',
    hideBelow: 'lg',
    cell: (l) => <span className="font-mono text-2xs text-slate-500">{l.entityId ?? '—'}</span>,
  },
  {
    key: 'ip',
    header: 'IP',
    hideBelow: 'md',
    cell: (l) => <span className="text-xs text-slate-500">{l.ip ?? '—'}</span>,
  },
];

// ---- helpers ---------------------------------------------------------------

function StatusDot({ s }: { s: 'up' | 'down' | 'unknown' }) {
  const color =
    s === 'up' ? 'bg-emerald-500' : s === 'down' ? 'bg-red-500' : 'bg-slate-400';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

function statusColor(s: 'up' | 'down' | 'unknown') {
  return s === 'up'
    ? 'text-emerald-400'
    : s === 'down'
      ? 'text-red-400'
      : 'text-slate-400';
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return `${d}d ${h}h`;
}

function timeAgo(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
