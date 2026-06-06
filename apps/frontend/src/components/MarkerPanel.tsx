'use client';

import { useState } from 'react';
import {
  DEVICE_TYPES,
  effectiveStatus,
  type Area,
  type CreateDeviceInput,
  type Device,
  type DeviceType,
  type ManualOverride,
  type PatchDevicePositionInput,
  type RouterPublic,
  type Site,
  type UpdateDeviceInput,
} from '@noc/shared';
import { api } from '@/lib/api';
import { DEVICE_ICONS, deviceSvg } from '@/lib/icons';
import { Button, Field, Select, StatusPill, Textarea, TextInput } from './ui';

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
  onClose: () => void;
  onSave: (id: string, patch: UpdateDeviceInput) => void;
  onCreate: (body: CreateDeviceInput) => void;
  onDelete: (id: string) => void;
}

export default function MarkerPanel(props: MarkerPanelProps) {
  const { site, mode, device, addPos, routers, areas } = props;

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

  const editable = mode === 'add' ? props.canCreate : props.canEditAttributes;
  const selectedArea = areas.find((a) => a.id === areaId);

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
    if (mode === 'add') {
      if (!routerId) return;
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
        <button onClick={props.onClose} className="text-slate-400 hover:text-slate-200">
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
          <Button variant="primary" onClick={save} disabled={!name}>
            {mode === 'add' ? 'Create' : 'Save'}
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
