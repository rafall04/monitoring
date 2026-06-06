'use client';

import { useState } from 'react';
import {
  STATUS_COLORS,
  STATUS_LABELS,
  effectiveStatus,
  type Area,
  type Device,
  type DeviceType,
  type Line,
  type Site,
} from '@noc/shared';
import { deviceSvg } from '@/lib/icons';
import { useAreaMutations, useReorderDevices } from '@/lib/queries';
import { Button, Select, TextInput } from './ui';

interface LineViewProps {
  site: Site;
  areas: Area[];
  devices: Device[];
  editable: boolean; // edit mode on
  canManageStructure: boolean; // site:manage
  canReorder: boolean; // device:edit-position
  onSelect: (d: Device) => void;
}

const sortDev = (a: Device, b: Device) =>
  a.orderIndex - b.orderIndex || a.name.localeCompare(b.name);

function rollup(devs: Device[]) {
  let up = 0,
    down = 0,
    unknown = 0,
    maint = 0;
  for (const d of devs) {
    const s = effectiveStatus(d.status, d.manualOverride);
    if (s === 'maintenance') maint++;
    else if (s === 'up') up++;
    else if (s === 'down') down++;
    else unknown++;
  }
  return { up, down, unknown, maint, total: devs.length };
}

function rollColor(r: ReturnType<typeof rollup>): string {
  if (r.down > 0) return STATUS_COLORS.down;
  if (r.unknown > 0) return STATUS_COLORS.unknown;
  if (r.total > 0) return STATUS_COLORS.up;
  return '#64748b';
}

function Rollup({ devs }: { devs: Device[] }) {
  const r = rollup(devs);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: rollColor(r), border: `1px solid ${rollColor(r)}55` }}
      title={`${r.up} up · ${r.down} down · ${r.unknown} unknown · ${r.maint} maintenance`}
    >
      {r.up}/{r.total} up{r.down > 0 ? ` · ${r.down}↓` : ''}
    </span>
  );
}

function glyph(d: Device): string {
  if (d.iconUrl)
    return `<img src="${d.iconUrl}" width="16" height="16" style="object-fit:contain;display:block" />`;
  return deviceSvg((d.iconKey as DeviceType) || d.type, 16);
}

function DeviceChip({
  device,
  onSelect,
  canReorder,
  isFirst,
  isLast,
  onMove,
}: {
  device: Device;
  onSelect: (d: Device) => void;
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: number) => void;
}) {
  const s = effectiveStatus(device.status, device.manualOverride);
  const color = STATUS_COLORS[s];
  return (
    <div className="flex items-center">
      <button
        onClick={() => onSelect(device)}
        title={`${device.name} — ${STATUS_LABELS[s]}${device.ipAddress ? ' · ' + device.ipAddress : ''}`}
        className="flex w-40 items-center gap-2 rounded-md border border-surface-border bg-surface-raised px-2.5 py-1.5 text-left hover:border-slate-500"
        style={{ borderLeftWidth: 3, borderLeftColor: color }}
      >
        <span className="shrink-0" style={{ color }} dangerouslySetInnerHTML={{ __html: glyph(device) }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-slate-200">{device.name}</span>
          <span className="block text-[10px]" style={{ color }}>
            {STATUS_LABELS[s]}
            {device.isCritical ? ' ★' : ''}
          </span>
        </span>
      </button>
      {canReorder && (
        <span className="ml-0.5 flex flex-col leading-none">
          <button
            disabled={isFirst}
            onClick={() => onMove(-1)}
            className="px-1 text-[10px] text-slate-500 hover:text-slate-200 disabled:opacity-30"
            title="Move earlier"
          >
            ◀
          </button>
          <button
            disabled={isLast}
            onClick={() => onMove(1)}
            className="px-1 text-[10px] text-slate-500 hover:text-slate-200 disabled:opacity-30"
            title="Move later"
          >
            ▶
          </button>
        </span>
      )}
    </div>
  );
}

export default function LineView({
  site,
  areas,
  devices,
  editable,
  canManageStructure,
  canReorder,
  onSelect,
}: LineViewProps) {
  const m = useAreaMutations(site.id);
  const reorder = useReorderDevices(site.id);

  const [areaDraft, setAreaDraft] = useState<{ name: string; kind: 'lines' | 'room' }>({
    name: '',
    kind: 'lines',
  });
  const [lineDraftFor, setLineDraftFor] = useState<string | null>(null);
  const [lineName, setLineName] = useState('');
  const [renaming, setRenaming] = useState<{ kind: 'area' | 'line'; id: string; name: string } | null>(
    null,
  );

  const manage = editable && canManageStructure;
  const reorderable = editable && canReorder;

  const byLine = (lineId: string) => devices.filter((d) => d.lineId === lineId).sort(sortDev);
  const looseInArea = (areaId: string) =>
    devices.filter((d) => d.areaId === areaId && !d.lineId).sort(sortDev);
  const inArea = (areaId: string) => devices.filter((d) => d.areaId === areaId).sort(sortDev);
  const unassigned = devices.filter((d) => !d.areaId).sort(sortDev);

  const move = (lane: Device[], index: number, delta: number) => {
    const next = [...lane];
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    reorder.mutate(next.map((d) => d.id));
  };

  const RenameOrName = ({
    kind,
    id,
    name,
    className,
  }: {
    kind: 'area' | 'line';
    id: string;
    name: string;
    className?: string;
  }) => {
    if (renaming && renaming.kind === kind && renaming.id === id) {
      return (
        <span className="inline-flex items-center gap-1">
          <TextInput
            autoFocus
            value={renaming.name}
            onChange={(e) => setRenaming({ kind, id, name: e.target.value })}
            className="h-7 w-40 py-0.5"
          />
          <Button
            onClick={() => {
              const v = renaming.name.trim();
              if (v) (kind === 'area' ? m.renameArea : m.renameLine).mutate({ id, name: v });
              setRenaming(null);
            }}
          >
            ✓
          </Button>
          <Button variant="ghost" onClick={() => setRenaming(null)}>
            ✕
          </Button>
        </span>
      );
    }
    return (
      <span className={className}>
        {name}
        {manage && (
          <button
            onClick={() => setRenaming({ kind, id, name })}
            className="ml-1.5 text-xs text-slate-500 hover:text-slate-300"
            title="Rename"
          >
            ✎
          </button>
        )}
      </span>
    );
  };

  return (
    <div className="h-full overflow-auto p-4 sm:p-5">
      {/* Add-area toolbar */}
      {manage && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-surface-border p-3">
          <span className="text-xs uppercase tracking-wide text-slate-500">New area</span>
          <TextInput
            placeholder="e.g. Assembly"
            value={areaDraft.name}
            onChange={(e) => setAreaDraft({ ...areaDraft, name: e.target.value })}
            className="h-8 w-44 py-1"
          />
          <Select
            value={areaDraft.kind}
            onChange={(e) => setAreaDraft({ ...areaDraft, kind: e.target.value as 'lines' | 'room' })}
            className="h-8 w-32 py-1"
          >
            <option value="lines">lines</option>
            <option value="room">room</option>
          </Select>
          <Button
            onClick={() => {
              if (areaDraft.name.trim())
                m.createArea.mutate(
                  { name: areaDraft.name.trim(), kind: areaDraft.kind },
                  { onSuccess: () => setAreaDraft({ name: '', kind: 'lines' }) },
                );
            }}
            disabled={!areaDraft.name.trim() || m.createArea.isPending}
          >
            Add area
          </Button>
        </div>
      )}

      {areas.length === 0 && unassigned.length === 0 && (
        <p className="text-sm text-slate-400">
          Belum ada area. {manage ? 'Tambahkan area di atas untuk mulai.' : 'Minta admin menata area & line.'}
        </p>
      )}

      <div className="space-y-5">
        {areas.map((area) => (
          <section key={area.id} className="rounded-lg border border-surface-border bg-surface-raised/40">
            <header className="flex flex-wrap items-center gap-2 border-b border-surface-border px-4 py-2.5">
              <RenameOrName
                kind="area"
                id={area.id}
                name={area.name}
                className="text-sm font-semibold text-slate-100"
              />
              <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                {area.kind}
              </span>
              <Rollup devs={inArea(area.id)} />
              <div className="ml-auto flex items-center gap-2">
                {manage && area.kind === 'lines' && (
                  <Button variant="ghost" onClick={() => { setLineDraftFor(area.id); setLineName(''); }}>
                    + Line
                  </Button>
                )}
                {manage && (
                  <button
                    onClick={() => m.deleteArea.mutate(area.id)}
                    className="text-xs text-red-400 hover:text-red-300"
                    title="Delete area (devices keep, just unassigned)"
                  >
                    ✕
                  </button>
                )}
              </div>
            </header>

            <div className="space-y-2 p-3">
              {/* inline add-line */}
              {manage && lineDraftFor === area.id && (
                <div className="flex items-center gap-2">
                  <TextInput
                    autoFocus
                    placeholder="e.g. Line A"
                    value={lineName}
                    onChange={(e) => setLineName(e.target.value)}
                    className="h-8 w-40 py-1"
                  />
                  <Button
                    onClick={() => {
                      if (lineName.trim())
                        m.createLine.mutate(
                          { areaId: area.id, name: lineName.trim() },
                          { onSuccess: () => { setLineName(''); setLineDraftFor(null); } },
                        );
                    }}
                    disabled={!lineName.trim() || m.createLine.isPending}
                  >
                    Add
                  </Button>
                  <Button variant="ghost" onClick={() => setLineDraftFor(null)}>
                    Cancel
                  </Button>
                </div>
              )}

              {area.kind === 'lines' ? (
                <>
                  {area.lines.length === 0 && lineDraftFor !== area.id && (
                    <p className="text-xs text-slate-500">Belum ada line di area ini.</p>
                  )}
                  {area.lines.map((line: Line) => {
                    const lane = byLine(line.id);
                    return (
                      <div key={line.id} className="rounded-md bg-surface/60 p-2">
                        <div className="mb-1.5 flex items-center gap-2">
                          <RenameOrName
                            kind="line"
                            id={line.id}
                            name={line.name}
                            className="text-xs font-semibold text-slate-300"
                          />
                          <Rollup devs={lane} />
                          {manage && (
                            <button
                              onClick={() => m.deleteLine.mutate(line.id)}
                              className="ml-auto text-xs text-red-400 hover:text-red-300"
                              title="Delete line"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {lane.map((d, i) => (
                            <DeviceChip
                              key={d.id}
                              device={d}
                              onSelect={onSelect}
                              canReorder={reorderable}
                              isFirst={i === 0}
                              isLast={i === lane.length - 1}
                              onMove={(delta) => move(lane, i, delta)}
                            />
                          ))}
                          {lane.length === 0 && (
                            <span className="px-1 py-2 text-xs text-slate-600">— kosong —</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {/* devices in this area but not on any line */}
                  {looseInArea(area.id).length > 0 && (
                    <div className="rounded-md border border-dashed border-surface-border p-2">
                      <div className="mb-1.5 text-xs text-slate-500">Tanpa line</div>
                      <div className="flex flex-wrap gap-2">
                        {looseInArea(area.id).map((d, i, arr) => (
                          <DeviceChip
                            key={d.id}
                            device={d}
                            onSelect={onSelect}
                            canReorder={reorderable}
                            isFirst={i === 0}
                            isLast={i === arr.length - 1}
                            onMove={(delta) => move(arr, i, delta)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {inArea(area.id).map((d, i, arr) => (
                    <DeviceChip
                      key={d.id}
                      device={d}
                      onSelect={onSelect}
                      canReorder={reorderable}
                      isFirst={i === 0}
                      isLast={i === arr.length - 1}
                      onMove={(delta) => move(arr, i, delta)}
                    />
                  ))}
                  {inArea(area.id).length === 0 && (
                    <span className="px-1 py-2 text-xs text-slate-600">— belum ada device —</span>
                  )}
                </div>
              )}
            </div>
          </section>
        ))}

        {/* Unassigned devices */}
        {unassigned.length > 0 && (
          <section className="rounded-lg border border-dashed border-amber-500/40 bg-surface-raised/40">
            <header className="flex items-center gap-2 border-b border-surface-border px-4 py-2.5">
              <span className="text-sm font-semibold text-amber-400">Belum ditempatkan</span>
              <Rollup devs={unassigned} />
              <span className="ml-auto text-xs text-slate-500">
                Buka device → pilih Area/Line untuk menempatkan
              </span>
            </header>
            <div className="flex flex-wrap gap-2 p-3">
              {unassigned.map((d) => (
                <DeviceChip
                  key={d.id}
                  device={d}
                  onSelect={onSelect}
                  canReorder={false}
                  isFirst
                  isLast
                  onMove={() => undefined}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
