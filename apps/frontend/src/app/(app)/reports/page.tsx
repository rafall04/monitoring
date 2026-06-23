'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSites } from '@/lib/queries';
import { Card, EmptyState, ErrorState, Field, Loading, Page, PageBody, PageHeader, Select } from '@/components/ui';

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

  return (
    <Page>
      <PageHeader title="Uptime / SLA" subtitle="Ketersediaan perangkat 30 hari terakhir." />
      <PageBody>
        <div className="max-w-xs">
          <Field label="Site filter">
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">All sites</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Card className="p-4">
          {report.isError ? (
            <ErrorState onRetry={() => void report.refetch()}>
              Gagal memuat laporan uptime.
            </ErrorState>
          ) : report.isLoading ? (
            <Loading />
          ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1">Device</th>
                <th>Current</th>
                <th>Outages</th>
                <th>Downtime</th>
                <th>Availability</th>
              </tr>
            </thead>
            <tbody>
              {report.data?.devices.map((d) => (
                <tr key={d.deviceId} className="border-t border-surface-border">
                  <td className="py-1.5">
                    {d.isCritical && <span className="mr-1 text-amber-400">★</span>}
                    {d.name}
                  </td>
                  <td>{d.currentStatus}</td>
                  <td>{d.outages}</td>
                  <td>{fmtDuration(d.downtimeSeconds)}</td>
                  <td className={d.availabilityPct < 99 ? 'text-red-400' : 'text-emerald-400'}>
                    {d.availabilityPct}%
                  </td>
                </tr>
              ))}
              {report.data?.devices.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-3 text-slate-500">
                    No devices.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        </Card>
      </PageBody>
    </Page>
  );
}
