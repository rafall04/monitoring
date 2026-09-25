'use client';

import { useEffect, useState } from 'react';
import {
  ALERT_DAY_LABELS,
  DEVICE_TYPES,
  effectiveStatus,
  type Area,
  type CreateDeviceInput,
  type Device,
  type DeviceType,
  type ManualOverride,
  type PatchDevicePositionInput,
  type RouterInterface,
  type RouterPublic,
  type Site,
  type UpdateDeviceInput,
} from '@noc/shared';
import { api } from '@/lib/api';
import { DEVICE_ICONS, deviceSvg } from '@/lib/icons';
import { useToast } from '@/lib/toast';
import { Button, Field, Select, StatusPill, Textarea, TextInput } from './ui';

const minToTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeToMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Probe mode — the backend treats watchInterface/watchPort as mutually
 *  exclusive (setting one clears the other); 'netwatch' = plain ping watch. */
type WatchMode = 'netwatch' | 'interface' | 'tcp';

interface MarkerPanelProps {
  site: Site;
  mode: 'edit' | 'add';
  device?: Device | null;
  addPos?: PatchDevicePositionInput;
  routers: RouterPublic[];
  areas: Area[];
  canEditAttributes: boolean;
  canCreate: boolean;
  canDelete: boolean;
  /** Parent mutation in flight — guards the submit button against double-click. */
  busy?: boolean;
  onClose: () => void;
  onSave: (id: string, patch: UpdateDeviceInput) => void;
  onCreate: (body: CreateDeviceInput) => void;
  onDelete: (id: string) => void;
}

export default function MarkerPanel(props: MarkerPanelProps) {
  const { site, mode, device, addPos, routers, areas } = props;
  const toast = useToast();

  const [name, setName] = useState(device?.name ?? '');
  const [ipAddress, setIpAddress] = useState(device?.ipAddress ?? '');
  const [type, setType] = useState<DeviceType>(device?.type ?? 'other');
  const [routerId, setRouterId] = useState(device?.routerId ?? routers[0]?.id ?? '');
  const [isCritical, setIsCritical] = useState(device?.isCritical ?? false);
  const [override, setOverride] = useState<ManualOverride | ''>(device?.manualOverride ?? '');
  const [note, setNote] = useState(device?.note ?? '');
  // ADD mode: auto-sync Netwatch when IP is set (no UI toggle — settings owned
  // by super_admin). EDIT mode: surfaced under an Advanced disclosure.
  const [syncNetwatch, setSyncNetwatch] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [iconKey, setIconKey] = useState<string | null>(device?.iconKey ?? null);
  const [iconUrl, setIconUrl] = useState<string | null>(device?.iconUrl ?? null);
  const [iconBusy, setIconBusy] = useState(false);
  const [areaId, setAreaId] = useState<string>(device?.areaId ?? '');
  const [lineId, setLineId] = useState<string>(device?.lineId ?? '');

  // Advanced watch: instead of plain Netwatch ping the status can follow a
  // RouterOS interface's running flag ("uplink") or a TCP connect to
  // ipAddress:watchPort from the NOC server. Alerts for probe devices are
  // gated by a work-hours window (per-device override or the global Settings
  // default).
  const [watchMode, setWatchMode] = useState<WatchMode>(
    device?.watchPort ? 'tcp' : device?.watchInterface ? 'interface' : 'netwatch',
  );
  const [watchInterface, setWatchInterface] = useState(device?.watchInterface ?? '');
  const [watchPort, setWatchPort] = useState(device?.watchPort ? String(device.watchPort) : '');
  const [winOverride, setWinOverride] = useState(Boolean(device?.watchAlertWindow));
  const [winStart, setWinStart] = useState(
    minToTime(device?.watchAlertWindow?.startMin ?? 360),
  );
  const [winEnd, setWinEnd] = useState(minToTime(device?.watchAlertWindow?.endMin ?? 1080));
  const [winDays, setWinDays] = useState<number[]>(
    device?.watchAlertWindow?.days ?? [1, 2, 3, 4, 5, 6, 7],
  );
  const [uplinkOpen, setUplinkOpen] = useState(
    Boolean(device?.watchInterface || device?.watchPort),
  );
  const [ifaces, setIfaces] = useState<RouterInterface[] | null>(null);
  const [ifacesErr, setIfacesErr] = useState('');

  const editable = mode === 'add' ? props.canCreate : props.canEditAttributes;
  const selectedArea = areas.find((a) => a.id === areaId);

  // Pull the live interface list only when the section is actually open and in
  // interface mode — the pick-list needs a router round-trip, don't pay it for
  // every panel open (or for netwatch/tcp probes that never show it).
  useEffect(() => {
    if (!uplinkOpen || !routerId || watchMode !== 'interface') return;
    setIfaces(null);
    setIfacesErr('');
    api
      .get<RouterInterface[]>(`/routers/${routerId}/interfaces`)
      .then(setIfaces)
      .catch((e) => setIfacesErr((e as Error)?.message ?? 'Gagal membaca interface'));
  }, [uplinkOpen, routerId, watchMode]);

  const uploadIcon = async (file: File) => {
    setIconBusy(true);
    try {
      const r = await api.upload<{ url: string }>(
        '/uploads/icon',
        (() => {
          const form = new FormData();
          form.append('file', file);
          return form;
        })(),
      );
      setIconUrl(r.url);
      setIconKey(null);
    } finally {
      setIconBusy(false);
    }
  };

  const save = () => {
    // Mutually exclusive watch fields — the backend clears the sibling anyway,
    // but sending both nulls keeps intent obvious in the request log.
    const watchFields =
      watchMode === 'interface'
        ? { watchInterface: watchInterface || null, watchPort: null }
        : watchMode === 'tcp'
          ? { watchInterface: null, watchPort: watchPort ? Number(watchPort) : null }
          : { watchInterface: null, watchPort: null };
    const watchWindow =
      watchMode !== 'netwatch' && winOverride
        ? { startMin: timeToMin(winStart), endMin: timeToMin(winEnd), days: winDays }
        : null;
    if (mode === 'add') {
      // Used to silently return — the operator got no hint why nothing happened.
      if (!routerId) {
        toast.error('Pilih router dulu — setiap device butuh router sebagai sumber Netwatch.');
        return;
      }
      // syncNetwatch defaults to true on the backend — operators don't need to
      // think about it. It's a no-op anyway when ipAddress is null.
      const body: CreateDeviceInput = {
        routerId,
        name,
        ipAddress: ipAddress || null,
        type,
        iconKey: iconKey || null,
        iconUrl: iconUrl || null,
        areaId: areaId || null,
        lineId: lineId || null,
        isCritical,
        note: note || null,
        ...watchFields,
        watchAlertWindow: watchWindow,
        ...addPos,
      } as CreateDeviceInput;
      props.onCreate(body);
    } else if (device) {
      const patch: UpdateDeviceInput = {
        name,
        ipAddress: ipAddress || null,
        type,
        iconKey: iconKey || null,
        iconUrl: iconUrl || null,
        areaId: areaId || null,
        lineId: lineId || null,
        isCritical,
        note: note || null,
        manualOverride: override === '' ? null : override,
        ...watchFields,
        watchAlertWindow: watchWindow,
        ...(syncNetwatch && ipAddress ? { syncNetwatch: true } : {}),
      };
      props.onSave(device.id, patch);
    }
  };

  return (
    <div className="flex h-full w-80 flex-col border-l border-surface-border bg-surface-raised">
      <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-100">
          {mode === 'add' ? 'Add device' : 'Edit device'}
        </h3>
        <button onClick={props.onClose} className="noc-tap inline-flex items-center text-slate-400 hover:text-slate-200">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {mode === 'edit' && device && (
          <div className="flex items-center justify-between">
            <StatusPill status={effectiveStatus(device.status, device.manualOverride)} />
            {device.statusSince && (
              <span className="text-xs text-slate-500">
                since {new Date(device.statusSince).toLocaleString()}
              </span>
            )}
          </div>
        )}

        {mode === 'add' && (
          <Field label="Router (Netwatch source)">
            <Select value={routerId} onChange={(e) => setRouterId(e.target.value)} disabled={!editable}>
              {routers.length === 0 && <option value="">No routers in this site</option>}
              {routers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.host})
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
        </Field>

        <Field label="IP address">
          <TextInput
            value={ipAddress}
            onChange={(e) => setIpAddress(e.target.value)}
            placeholder="e.g. 192.168.88.10"
            disabled={!editable}
          />
        </Field>

        <details
          className="rounded border border-surface-border bg-surface/40 p-2 text-xs text-slate-400"
          open={uplinkOpen}
          onToggle={(e) => setUplinkOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer select-none text-slate-300">
            Pantauan lanjutan
          </summary>

          <Select
            className="mt-2"
            value={watchMode}
            onChange={(e) => setWatchMode(e.target.value as WatchMode)}
            disabled={!editable}
          >
            <option value="netwatch">Netwatch (ping)</option>
            <option value="interface">Interface router</option>
            <option value="tcp">Port TCP</option>
          </Select>

          {watchMode === 'netwatch' && (
            <p className="mt-2">
              Default — status diukur dari ping Netwatch yang dipasang di router.
            </p>
          )}

          {watchMode === 'interface' && (
            <>
              <p className="mt-2">
                Status device mengikuti flag <code>running</code> interface di router (mis.{' '}
                <code>ether2</code> = jalur ke 001) — bukan Netwatch. Alert hanya dikirim dalam
                jam kerja; status peta tetap diperbarui 24 jam.
              </p>
              {ifaces === null && !ifacesErr ? (
                <p className="mt-2 text-slate-500">Membaca daftar interface dari router…</p>
              ) : ifacesErr ? (
                <>
                  <TextInput
                    value={watchInterface}
                    onChange={(e) => setWatchInterface(e.target.value)}
                    placeholder="nama interface, mis. ether2"
                    disabled={!editable}
                  />
                  <p className="mt-1 text-amber-400/80">
                    Router tidak bisa dihubungi — isi nama interface manual. ({ifacesErr})
                  </p>
                </>
              ) : (
                <Select
                  value={watchInterface}
                  onChange={(e) => {
                    setWatchInterface(e.target.value);
                    if (e.target.value && type === 'other') setType('uplink');
                  }}
                  disabled={!editable}
                >
                  <option value="">— tidak dipantau —</option>
                  {ifaces!.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name} ({i.type}){i.disabled ? ' — disabled' : i.running ? ' — running' : ' — off'}
                    </option>
                  ))}
                  {watchInterface && !ifaces!.some((i) => i.name === watchInterface) && (
                    <option value={watchInterface}>{watchInterface} (tidak ada di router)</option>
                  )}
                </Select>
              )}
            </>
          )}

          {watchMode === 'tcp' && (
            <div className="mt-2 space-y-1">
              <span className="block text-2xs font-medium uppercase tracking-wide text-slate-500">
                Port TCP
              </span>
              <TextInput
                type="number"
                min={1}
                max={65535}
                value={watchPort}
                onChange={(e) => setWatchPort(e.target.value)}
                placeholder="1433"
                disabled={!editable}
              />
              <p>
                Status diukur dari koneksi TCP server NOC ke{' '}
                <code>
                  {ipAddress || 'ip'}:{watchPort || 'port'}
                </code>{' '}
                — mendeteksi &quot;host up tapi service mati&quot;.
              </p>
              {!ipAddress && (
                <p className="text-amber-400/80">
                  Isi IP address dulu — probe TCP butuh target; tanpa IP status tetap unknown.
                </p>
              )}
            </div>
          )}

          {watchMode !== 'netwatch' && (
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-slate-300">
                <input
                  type="checkbox"
                  checked={winOverride}
                  onChange={(e) => setWinOverride(e.target.checked)}
                  disabled={!editable}
                />
                Jam alert khusus device ini
              </label>
              {winOverride ? (
                <>
                  <div className="flex items-center gap-2">
                    <TextInput
                      type="time"
                      value={winStart}
                      onChange={(e) => setWinStart(e.target.value)}
                      disabled={!editable}
                    />
                    <span>s.d.</span>
                    <TextInput
                      type="time"
                      value={winEnd}
                      onChange={(e) => setWinEnd(e.target.value)}
                      disabled={!editable}
                    />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {ALERT_DAY_LABELS.map((label, i) => {
                      const day = i + 1;
                      const on = winDays.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          disabled={!editable}
                          onClick={() =>
                            setWinDays(
                              on ? winDays.filter((d) => d !== day) : [...winDays, day].sort(),
                            )
                          }
                          className={`rounded border px-2 py-0.5 disabled:opacity-50 ${
                            on
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-surface-border text-slate-400'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="text-slate-500">Mengikuti jam kerja global di Settings.</p>
              )}
            </div>
          )}
        </details>

        <Field label="Type">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as DeviceType)}
            disabled={!editable}
          >
            {DEVICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Area">
          <Select
            value={areaId}
            onChange={(e) => {
              setAreaId(e.target.value);
              setLineId('');
            }}
            disabled={!editable}
          >
            <option value="">— none —</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {selectedArea?.kind === 'lines' && (
          <Field label="Line">
            <Select value={lineId} onChange={(e) => setLineId(e.target.value)} disabled={!editable}>
              <option value="">— none —</option>
              {selectedArea.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div>
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Icon
          </span>
          <div className="grid grid-cols-6 gap-1">
            {(Object.keys(DEVICE_ICONS) as DeviceType[]).map((key) => {
              const selected = !iconUrl && (iconKey ?? type) === key;
              return (
                <button
                  key={key}
                  type="button"
                  title={key}
                  disabled={!editable}
                  onClick={() => {
                    setIconKey(key);
                    setIconUrl(null);
                  }}
                  className={`flex items-center justify-center rounded border p-1.5 disabled:opacity-50 ${
                    selected
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-surface-border text-slate-300 hover:border-slate-500'
                  }`}
                  dangerouslySetInnerHTML={{ __html: deviceSvg(key, 18) }}
                />
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {iconUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={iconUrl} alt="custom icon" className="h-6 w-6 rounded object-contain" />
                <span className="text-xs text-slate-400">custom icon</span>
                {editable && (
                  <button
                    type="button"
                    className="text-xs text-red-400 hover:text-red-300"
                    onClick={() => setIconUrl(null)}
                  >
                    remove
                  </button>
                )}
              </>
            ) : (
              editable && (
                <label className="cursor-pointer text-xs text-accent hover:opacity-80">
                  {iconBusy ? 'Uploading…' : 'Upload custom (SVG/PNG)…'}
                  <input
                    type="file"
                    accept="image/png,image/webp,image/jpeg,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadIcon(f);
                    }}
                  />
                </label>
              )
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={isCritical}
            onChange={(e) => setIsCritical(e.target.checked)}
            disabled={!editable}
          />
          Critical device
        </label>

        {mode === 'edit' && (
          <Field label="Manual override">
            <Select
              value={override}
              onChange={(e) => setOverride(e.target.value as ManualOverride | '')}
              disabled={!editable}
            >
              <option value="">— none —</option>
              <option value="maintenance">maintenance (suppress alarms)</option>
            </Select>
          </Field>
        )}

        {mode === 'add' ? (
          <p className="rounded border border-surface-border bg-surface/40 p-2 text-xs text-slate-400">
            {ipAddress
              ? 'Netwatch entry akan dibuat otomatis di router. Default ping interval, timeout, dan template alert diatur super_admin di Settings.'
              : 'Tambahkan IP agar Netwatch bisa dibuat otomatis di router.'}
          </p>
        ) : (
          <details
            className="rounded border border-surface-border bg-surface/40 p-2 text-xs text-slate-400"
            open={showAdvanced}
            onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer select-none text-slate-300">Advanced</summary>
            <label className="mt-2 flex items-start gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={syncNetwatch}
                onChange={(e) => setSyncNetwatch(e.target.checked)}
                disabled={!editable || !ipAddress}
              />
              <span>
                Re-install the Netwatch entry on the router
                <span className="mt-0.5 block text-xs text-slate-500">
                  {ipAddress
                    ? 'Pushes /tool/netwatch again — use after an IP change. Defaults from Settings.'
                    : 'Set an IP address first.'}
                </span>
              </span>
            </label>
          </details>
        )}

        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} disabled={!editable} />
        </Field>

        <p className="text-xs text-slate-500">
          {site.mapMode === 'geo'
            ? 'Drag the marker on the map (edit mode) to set its lat/lng.'
            : 'Drag the marker on the map (edit mode) to set its X/Y on the floorplan.'}
        </p>
      </div>

      {editable && (
        <div className="flex items-center justify-between gap-2 border-t border-surface-border p-4">
          <Button variant="primary" onClick={save} disabled={!name || props.busy}>
            {props.busy ? 'Menyimpan…' : mode === 'add' ? 'Create' : 'Save'}
          </Button>
          {mode === 'edit' && device && props.canDelete && (
            <Button variant="danger" onClick={() => props.onDelete(device.id)}>
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
