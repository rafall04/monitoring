'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSites } from '@/lib/queries';
import {
  type Column,
  DataTable,
  EmptyState,
  Page,
  PageBody,
  PageHeader,
  Select,
  Toolbar,
} from '@/components/ui';

interface UptimeRow {
  deviceId: string;
  name: string;
  siteId: string;
  isCritical: boolean;
  currentStatus: string;
  outages: number;
  downtimeSeconds: number;
  availabilityPct: number;
}
interface UptimeReport {
  from: string;
  to: string;
  devices: UptimeRow[];
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function ReportsPage() {
  const { can } = useAuth();
  const canView = can('reports:view');
  const sites = useSites();
  const [siteId, setSiteId] = useState('');
  const report = useQuery({
    queryKey: ['uptime', siteId],
    queryFn: () => api.get<UptimeReport>(`/reports/uptime${siteId ? `?siteId=${siteId}` : ''}`),
    enabled: canView,
  });

  if (!canView)
    return (
      <Page>
        <PageHeader title="Uptime / SLA" />
        <PageBody>
          <EmptyState>You do not have access to reports.</EmptyState>
        </PageBody>
      </Page>
    );

  const rows = report.data?.devices ?? [];

  return (
    <Page>
      <PageHeader title="Uptime / SLA" subtitle="Ketersediaan perangkat 30 hari terakhir." />
      <PageBody>
        <Toolbar
          left={
            <>
              <span className="text-xs text-slate-400">Site</span>
              <Select
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                className="w-full sm:w-56"
              >
                <option value="">All sites</option>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </>
          }
          right={rows.length > 0 && <span className="text-xs text-slate-500">{rows.length} perangkat</span>}
        />

        <DataTable
          columns={UPTIME_COLUMNS}
          rows={rows}
          rowKey={(d) => d.deviceId}
          loading={report.isLoading}
          error={report.isError}
          onRetry={() => void report.refetch()}
          empty="Belum ada data uptime."
          dense
        />
      </PageBody>
    </Page>
  );
}

const UPTIME_COLUMNS: ReadonlyArray<Column<UptimeRow>> = [
  {
    key: 'device',
    header: 'Device',
    cell: (d) => (
      <span className="font-medium text-slate-100">
        {d.isCritical && (
          <span className="mr-1 text-amber-400" title="critical">
            ★
          </span>
        )}
        {d.name}
      </span>
    ),
  },
  { key: 'current', header: 'Current', cell: (d) => <span className="text-slate-400">{d.currentStatus}</span> },
  { key: 'outages', header: 'Outages', align: 'right', hideBelow: 'md', cell: (d) => d.outages },
  {
    key: 'downtime',
    header: 'Downtime',
    align: 'right',
    hideBelow: 'md',
    cell: (d) => fmtDuration(d.downtimeSeconds),
  },
  {
    key: 'availability',
    header: 'Availability',
    align: 'right',
    cell: (d) => (
      <span
        className={`font-semibold ${d.availabilityPct < 99 ? 'text-red-400' : 'text-emerald-400'}`}
      >
        {d.availabilityPct}%
      </span>
    ),
  },
];
