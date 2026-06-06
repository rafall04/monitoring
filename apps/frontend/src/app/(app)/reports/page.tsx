'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSites } from '@/lib/queries';
import { Card, Field, Select, Spinner } from '@/components/ui';

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
    return <div className="p-6 text-slate-400">You do not have access to reports.</div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-xl font-semibold text-slate-100">Uptime / SLA (last 30 days)</h1>
      <div className="mb-4 max-w-xs">
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
        {report.isLoading ? (
          <Spinner />
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
    </div>
  );
}
