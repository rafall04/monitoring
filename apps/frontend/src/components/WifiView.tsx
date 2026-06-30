'use client';

import { useMemo } from 'react';
import {
  STATUS_COLORS,
  STATUS_LABELS,
  effectiveStatus,
  type Device,
  type DeviceType,
  type DeviceWifiLink,
} from '@noc/shared';
import { deviceSvg, escapeHtml } from '@/lib/icons';
import { rssiQuality } from '@/lib/wifi';
import SignalBars from './SignalBars';

interface WifiViewProps {
  devices: Device[];
  wifiLinks: Record<string, DeviceWifiLink>;
  updatedAt: string | null;
  onSelect: (d: Device) => void;
}

interface ApGroup {
  apName: string;
  ssids: Set<string>;
  rows: { device: Device; link: DeviceWifiLink }[];
}

function glyph(d: Device): string {
  if (d.iconUrl)
    return `<img src="${escapeHtml(d.iconUrl)}" width="16" height="16" style="object-fit:contain;display:block" />`;
  return deviceSvg((d.iconKey as DeviceType) || d.type, 16);
}

/**
 * Lightweight, DOM-only WiFi "denah": devices grouped by the Ruijie AP they're
 * connected to (live correlation), no Leaflet/floorplan needed. Each AP is a
 * zone card; the disconnected devices fall into a final muted group.
 */
export default function WifiView({ devices, wifiLinks, updatedAt, onSelect }: WifiViewProps) {
  const { groups, offline, connectedCount } = useMemo(() => {
    const byAp = new Map<string, ApGroup>();
    const offline: Device[] = [];
    for (const d of devices) {
      const link = wifiLinks[d.id];
      if (!link) {
        offline.push(d);
        continue;
      }
      const ap = link.apName || '(AP tak dikenal)';
      const g = byAp.get(ap) ?? { apName: ap, ssids: new Set<string>(), rows: [] };
      if (link.ssid) g.ssids.add(link.ssid);
      g.rows.push({ device: d, link });
      byAp.set(ap, g);
    }
    const groups = [...byAp.values()].sort((a, b) => a.apName.localeCompare(b.apName));
    for (const g of groups) g.rows.sort((a, b) => (b.link.rssi ?? -999) - (a.link.rssi ?? -999));
    const connectedCount = groups.reduce((n, g) => n + g.rows.length, 0);
    offline.sort((a, b) => a.name.localeCompare(b.name));
    return { groups, offline, connectedCount };
  }, [devices, wifiLinks]);

  const bestRssi = (g: ApGroup) =>
    g.rows.reduce<number | null>((m, r) => (r.link.rssi ?? -999) > (m ?? -999) ? r.link.rssi : m, null);

  return (
    <div className="h-full overflow-auto p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-400">
        <span>
          <span className="font-semibold text-slate-100">{connectedCount}</span> dari {devices.length}{' '}
          device terhubung · <span className="font-semibold text-slate-100">{groups.length}</span> AP
        </span>
        {updatedAt && (
          <span className="text-xs text-slate-500">
            diperbarui {new Date(updatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-slate-400">
          Belum ada data koneksi WiFi. Pastikan akun Ruijie & pemetaan project→site sudah diatur, lalu
          tunggu siklus enrich (≤5 menit).
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <section key={g.apName} className="rounded-lg border border-surface-border bg-surface-raised/40">
              <header className="flex items-center gap-2 border-b border-surface-border px-3 py-2">
                <WifiGlyph />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-100" title={g.apName}>
                    {g.apName}
                  </span>
                  {g.ssids.size > 0 && (
                    <span className="block truncate text-[10px] text-slate-500">
                      SSID {[...g.ssids].join(', ')}
                    </span>
                  )}
                </span>
                <span className="shrink-0 rounded-full border border-surface-border px-2 py-0.5 text-[11px] text-slate-300">
                  {g.rows.length}
                </span>
                <SignalBars rssi={bestRssi(g)} />
              </header>
              <div className="space-y-1 p-2">
                {g.rows.map(({ device, link }) => (
                  <DeviceRow key={device.id} device={device} link={link} onSelect={onSelect} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {offline.length > 0 && (
        <section className="mt-4 rounded-lg border border-dashed border-surface-border bg-surface-raised/30">
          <header className="flex items-center gap-2 border-b border-surface-border px-3 py-2">
            <span className="text-sm font-semibold text-slate-400">Tidak terhubung WiFi</span>
            <span className="rounded-full border border-surface-border px-2 py-0.5 text-[11px] text-slate-500">
              {offline.length}
            </span>
            <span className="ml-auto text-xs text-slate-600">device mati / kabel / di luar jangkauan</span>
          </header>
          <div className="flex flex-wrap gap-1.5 p-2">
            {offline.map((d) => {
              const s = effectiveStatus(d.status, d.manualOverride);
              return (
                <button
                  key={d.id}
                  onClick={() => onSelect(d)}
                  title={`${d.name} — ${STATUS_LABELS[s]}`}
                  className="flex items-center gap-1.5 rounded border border-surface-border bg-surface/60 px-2 py-1 text-left text-xs text-slate-300 hover:border-slate-500"
                  style={{ borderLeftWidth: 3, borderLeftColor: STATUS_COLORS[s] }}
                >
                  <span style={{ color: STATUS_COLORS[s] }} dangerouslySetInnerHTML={{ __html: glyph(d) }} />
                  <span className="max-w-[7rem] truncate">{d.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function DeviceRow({
  device,
  link,
  onSelect,
}: {
  device: Device;
  link: DeviceWifiLink;
  onSelect: (d: Device) => void;
}) {
  const s = effectiveStatus(device.status, device.manualOverride);
  const color = STATUS_COLORS[s];
  return (
    <button
      onClick={() => onSelect(device)}
      title={`${device.name} — ${STATUS_LABELS[s]} · ${link.rssi ?? '—'} dBm ${rssiQuality(link.rssi).label}`}
      className="flex w-full items-center gap-2 rounded-md border border-surface-border bg-surface-raised px-2 py-1.5 text-left hover:border-slate-500"
      style={{ borderLeftWidth: 3, borderLeftColor: color }}
    >
      <span className="shrink-0" style={{ color }} dangerouslySetInnerHTML={{ __html: glyph(device) }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-slate-200">{device.name}</span>
        <span className="block truncate text-[10px] text-slate-500">
          {device.ipAddress ?? '—'}
          {link.band ? ` · ${link.band}` : ''}
        </span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{link.rssi ?? '—'}</span>
      <SignalBars rssi={link.rssi} />
    </button>
  );
}

function WifiGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-accent"
    >
      <path d="M5 12.55a11 11 0 0 1 14 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}
