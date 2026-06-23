'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditLogRow, Incident, StatusEventRow } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button, Card, EmptyState, ErrorState, Loading, Page, PageBody, PageHeader, Select, Tabs } from '@/components/ui';

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded bg-red-500/15 px-2 py-1 text-red-400">
          {rows.length} open
        </span>
        {critical > 0 && (
          <span className="rounded bg-amber-500/15 px-2 py-1 text-amber-400">
            {critical} critical
          </span>
        )}
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={criticalOnly}
            onChange={(e) => setCriticalOnly(e.target.checked)}
          />
          critical only
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState>Tidak ada insiden terbuka. 🎉</EmptyState>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2"></th>
                <th>Device</th>
                <th>Site</th>
                <th>Down for</th>
                <th>Ack</th>
                <th>Silence</th>
                <th className="px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.deviceId} className="border-t border-surface-border">
                  <td className="px-3 py-2">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${
                      r.isCritical ? 'bg-amber-400' : 'bg-red-500'
                    }`} />
                  </td>
                  <td className="font-medium text-slate-100">{r.deviceName}</td>
                  <td className="text-slate-400">{r.siteName}</td>
                  <td>{formatDuration(r.durationSec)}</td>
                  <td className="text-xs">
                    {r.ackBy ? (
                      <span className="text-emerald-400">
                        ✓ {r.ackBy}
                        {r.ackAt && <span className="text-slate-500"> · {timeAgo(r.ackAt)}</span>}
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {r.silencedUntil ? (
                      <span className="text-amber-400">until {new Date(r.silencedUntil).toLocaleString()}</span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canAck && (
                      <div className="flex justify-end gap-1.5 text-xs">
                        {r.ackBy ? (
                          <button
                            className="text-slate-400 hover:text-slate-200"
                            onClick={() => unack.mutate(r.deviceId)}
                          >
                            unack
                          </button>
                        ) : (
                          <button
                            className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-300 hover:bg-emerald-500/25"
                            onClick={() => ack.mutate(r.deviceId)}
                          >
                            Acknowledge
                          </button>
                        )}
                        <SilenceMenu
                          silenced={!!r.silencedUntil}
                          onPick={(minutes) =>
                            silence.mutate({ deviceId: r.deviceId, minutes })
                          }
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-[11px] text-slate-500">
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
        className={`rounded px-2 py-1 ${
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
              className="block w-full px-3 py-1 text-left text-xs hover:bg-slate-800"
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
              className="block w-full border-t border-surface-border px-3 py-1 text-left text-xs text-red-400 hover:bg-slate-800"
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
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-slate-400">Status</span>
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
        <label className="flex items-center gap-2 text-slate-400">
          <input
            type="checkbox"
            checked={criticalOnly}
            onChange={(e) => setCriticalOnly(e.target.checked)}
          />
          critical only
        </label>
      </div>

      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()}>Gagal memuat event.</ErrorState>
      ) : q.isLoading ? (
        <Loading />
      ) : (q.data?.events.length ?? 0) === 0 ? (
        <EmptyState>Belum ada event.</EmptyState>
      ) : (
        <Card className="overflow-x-auto p-0">
          <ul className="divide-y divide-surface-border">
            {q.data?.events.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <StatusDot s={e.newStatus} />
                <span className="font-medium text-slate-100">{e.deviceName}</span>
                {e.isCritical && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                    critical
                  </span>
                )}
                <span className="text-slate-400">@ {e.siteName}</span>
                <span className="ml-auto text-xs text-slate-500">
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
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-slate-400">Entity</span>
        <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-36">
          {entities.map((e) => (
            <option key={e || 'all'} value={e}>
              {e || 'all'}
            </option>
          ))}
        </Select>
      </div>

      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()}>Gagal memuat audit log.</ErrorState>
      ) : q.isLoading ? (
        <Loading />
      ) : (q.data?.logs.length ?? 0) === 0 ? (
        <EmptyState>Tidak ada entri.</EmptyState>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">When</th>
                <th>User</th>
                <th>Action</th>
                <th>Entity</th>
                <th>ID</th>
                <th className="px-3">IP</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.logs.map((l) => (
                <tr key={l.id} className="border-t border-surface-border">
                  <td className="px-3 py-1.5 text-xs text-slate-400">
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td className="text-slate-300">{l.userName ?? '—'}</td>
                  <td className="font-medium text-slate-100">{l.action}</td>
                  <td className="text-slate-400">{l.entity}</td>
                  <td className="font-mono text-[11px] text-slate-500">{l.entityId ?? '—'}</td>
                  <td className="px-3 text-xs text-slate-500">{l.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

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
