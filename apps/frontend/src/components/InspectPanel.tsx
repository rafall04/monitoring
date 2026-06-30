'use client';

import type { ReactNode } from 'react';
import {
  effectiveStatus,
  type Area,
  type Device,
  type DeviceWifiLink,
  type RouterPublic,
} from '@noc/shared';
import { deviceSvg } from '@/lib/icons';
import { rssiQuality } from '@/lib/wifi';
import SignalBars from './SignalBars';
import { Button, StatusPill } from './ui';

interface InspectPanelProps {
  device: Device;
  routers: RouterPublic[];
  areas: Area[];
  wifi?: DeviceWifiLink | null;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
}

// Read-only device detail drawer. Shown when a marker is clicked outside edit
// mode so "look at status" is cleanly separated from "change the device" — the
// Edit button hands off to the editable MarkerPanel.
export default function InspectPanel({
  device,
  routers,
  areas,
  wifi,
  canEdit,
  onEdit,
  onClose,
}: InspectPanelProps) {
  const disp = effectiveStatus(device.status, device.manualOverride);
  const router = routers.find((r) => r.id === device.routerId);
  const area = areas.find((a) => a.id === device.areaId);
  const line = area?.lines.find((l) => l.id === device.lineId);
  const silenced =
    device.silencedUntil != null && new Date(device.silencedUntil).getTime() > Date.now();

  return (
    <div className="flex h-full w-full flex-col border-l border-surface-border bg-surface-raised sm:w-80">
      <div className="flex items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {device.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={device.iconUrl} alt="" className="h-[18px] w-[18px] shrink-0 rounded object-contain" />
          ) : (
            <span
              className="shrink-0 text-slate-300"
              dangerouslySetInnerHTML={{ __html: deviceSvg(device.type, 18) }}
            />
          )}
          <h3 className="truncate text-sm font-semibold text-slate-100" title={device.name}>
            {device.name}
          </h3>
        </div>
        <button onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-200" aria-label="Tutup">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Status block */}
        <div className="rounded-lg border border-surface-border bg-surface/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <StatusPill status={disp} />
            <span className="text-xs text-slate-400">selama {since(device.statusSince)}</span>
          </div>
          {(device.isCritical || device.manualOverride === 'maintenance' || (disp === 'down' && device.ackBy) || silenced) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {device.isCritical && <Badge tone="red">Critical</Badge>}
              {device.manualOverride === 'maintenance' && <Badge tone="amber">Maintenance</Badge>}
              {disp === 'down' && device.ackBy && <Badge tone="slate">Ack: {device.ackBy}</Badge>}
              {silenced && <Badge tone="slate">Silenced</Badge>}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="divide-y divide-surface-border">
          <Row label="IP">
            {device.ipAddress ? <span className="font-mono">{device.ipAddress}</span> : '—'}
          </Row>
          <Row label="Tipe">{device.type.replace(/_/g, ' ')}</Row>
          <Row label="Router">{router?.name ?? '—'}</Row>
          <Row label="Area">
            {area ? area.name : '—'}
            {line ? ` · ${line.name}` : ''}
          </Row>
          <Row label="Status sejak">{device.statusSince ? fmt(device.statusSince) : '—'}</Row>
          {device.note && <Row label="Catatan">{device.note}</Row>}
        </div>

        {/* WiFi connection (Ruijie correlation, read-only) */}
        {wifi && (
          <div className="rounded-lg border border-surface-border bg-surface/40 p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Koneksi WiFi
              </span>
              <SignalBars rssi={wifi.rssi} />
            </div>
            <div className="divide-y divide-surface-border">
              <Row label="Access Point">{wifi.apName ?? '—'}</Row>
              <Row label="SSID">{wifi.ssid ?? '—'}</Row>
              <Row label="Band">{wifi.band ?? '—'}</Row>
              <Row label="Sinyal">
                {wifi.rssi != null ? `${wifi.rssi} dBm · ${rssiQuality(wifi.rssi).label}` : '—'}
              </Row>
              {wifi.onlineSince != null && (
                <Row label="Terhubung">{since(new Date(wifi.onlineSince).toISOString())}</Row>
              )}
            </div>
          </div>
        )}
      </div>

      {canEdit && (
        <div className="border-t border-surface-border p-4">
          <Button variant="secondary" className="w-full" onClick={onEdit}>
            Edit device
          </Button>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-right text-sm text-slate-200">{children}</span>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'red' | 'amber' | 'slate'; children: ReactNode }) {
  const cls =
    tone === 'red'
      ? 'bg-red-500/15 text-red-400'
      : tone === 'amber'
        ? 'bg-amber-500/15 text-amber-400'
        : 'bg-slate-500/15 text-slate-300';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

/** Compact "how long in this status" string, e.g. "2j 15m", "3h 4j". */
function since(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}h ${h % 24}j`;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
