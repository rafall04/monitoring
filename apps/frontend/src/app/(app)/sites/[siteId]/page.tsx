'use client';

import { useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { Device, PatchDevicePositionInput } from '@noc/shared';
import { useAuth } from '@/lib/auth';
import {
  applyWsEvent,
  useCreateDevice,
  useDeleteDevice,
  useMoveDevice,
  useRouters,
  useSite,
  useSiteAreas,
  useSiteDevices,
  useSiteSummary,
  useUpdateDevice,
} from '@/lib/queries';
import { useConfirm, useToast } from '@/lib/toast';
import { useSiteSocket } from '@/lib/ws';
import LineView from '@/components/LineView';
import MarkerPanel from '@/components/MarkerPanel';
import { Button, Legend, Spinner } from '@/components/ui';

// Leaflet touches `window`, so the map must be client-only.
const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <Spinner label="Loading map…" />
    </div>
  ),
});

export default function SiteMapPage() {
  const params = useParams<{ siteId: string }>();
  const siteId = params.siteId;
  const qc = useQueryClient();
  const { can } = useAuth();

  const site = useSite(siteId);
  const devices = useSiteDevices(siteId);
  const summary = useSiteSummary(siteId);
  const routers = useRouters(siteId);
  const areas = useSiteAreas(siteId);

  const [tab, setTab] = useState<'line' | 'denah'>('line');
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Device | null>(null);
  // 'manual' = add from a button (no map coords yet); object = placed on the map.
  const [adding, setAdding] = useState<PatchDevicePositionInput | 'manual' | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  useSiteSocket(
    siteId,
    useCallback((ev) => applyWsEvent(qc, ev), [qc]),
  );

  const move = useMoveDevice(siteId);
  const update = useUpdateDevice(siteId);
  const create = useCreateDevice(siteId);
  const remove = useDeleteDevice(siteId);

  const canEditPos = can('device:edit-position');
  const canEditAttr = can('device:edit-attributes');
  const canCreate = can('device:create');
  const canDelete = can('device:delete');
  const canManageStructure = can('site:manage');
  const editable = editMode && canEditPos;

  if (site.isLoading || devices.isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  if (!site.data)
    return <div className="p-6 text-slate-400">Site not found or you do not have access.</div>;

  const s = summary.data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-surface-border px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{site.data.name}</h1>
          <p className="text-xs text-slate-400">
            {site.data.region ? `${site.data.region} · ` : ''}
            {devices.data?.length ?? 0} devices
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {s && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-emerald-400">{s.up} up</span>
              <span className="text-red-400">{s.down} down</span>
              <span className="text-slate-400">{s.unknown} ?</span>
              <span className="font-semibold text-slate-100">{s.availabilityPct}%</span>
            </div>
          )}
          <div className="flex overflow-hidden rounded-md border border-surface-border">
            {(['line', 'denah'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 text-xs font-medium ${
                  tab === t ? 'bg-accent text-white' : 'text-slate-400 hover:bg-slate-800'
                }`}
              >
                {t === 'line' ? 'Line / Area' : 'Denah'}
              </button>
            ))}
          </div>
          {tab === 'denah' && <Legend />}
          {canCreate && (
            <Button
              variant="secondary"
              onClick={() => {
                setSelected(null);
                setAdding('manual');
              }}
            >
              + Add device
            </Button>
          )}
          {(canEditPos || canCreate || canManageStructure) && (
            <Button
              variant={editMode ? 'primary' : 'secondary'}
              onClick={() => {
                setEditMode((v) => !v);
                setAdding(null);
              }}
            >
              {editMode ? 'Done editing' : 'Edit'}
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {tab === 'line' ? (
            <LineView
              site={site.data}
              areas={areas.data ?? []}
              devices={devices.data ?? []}
              editable={editMode}
              canManageStructure={canManageStructure}
              canReorder={canEditPos}
              onSelect={(d) => {
                setAdding(null);
                setSelected(d);
              }}
            />
          ) : (
            <>
              <MapView
                site={site.data}
                devices={devices.data ?? []}
                editable={editable}
                onSelect={(d) => {
                  setAdding(null);
                  setSelected(d);
                }}
                onMove={(id, pos) => move.mutate({ id, pos })}
                onMapAdd={
                  editMode && canCreate
                    ? (pos) => {
                        setSelected(null);
                        setAdding(pos);
                      }
                    : undefined
                }
              />
              {editMode && (
                <div className="pointer-events-none absolute left-3 top-3 z-[1000] rounded bg-surface-raised/90 px-3 py-1 text-xs text-slate-300">
                  {canCreate ? 'Click empty space to add a device. ' : ''}
                  Drag markers to reposition.
                </div>
              )}
            </>
          )}
        </div>

        {(selected || adding) && (
          <MarkerPanel
            site={site.data}
            mode={adding ? 'add' : 'edit'}
            device={selected}
            addPos={adding && adding !== 'manual' ? adding : undefined}
            routers={routers.data ?? []}
            areas={areas.data ?? []}
            canEditAttributes={canEditAttr}
            canCreate={canCreate}
            canDelete={canDelete}
            onClose={() => {
              setSelected(null);
              setAdding(null);
            }}
            onSave={(id, patch) =>
              update.mutate(
                { id, patch },
                {
                  onSuccess: (d) => {
                    setSelected(null);
                    if (patch.syncNetwatch) {
                      if (d.netwatchError) toast.error(`Netwatch gagal di-update: ${d.netwatchError}`);
                      else toast.ok(`Netwatch untuk "${d.name}" diperbarui di router ✓`);
                    } else {
                      toast.ok('Tersimpan');
                    }
                  },
                  onError: (e) => toast.error(`Gagal menyimpan: ${(e as Error).message}`),
                },
              )
            }
            onCreate={(body) =>
              create.mutate(body, {
                onSuccess: (d) => {
                  setAdding(null);
                  setSelected(d);
                  // syncNetwatch now defaults to true on the backend; the only
                  // reason it would NOT have run is when IP was empty.
                  if (d.netwatchError) {
                    toast.error(`Device dibuat, tetapi Netwatch GAGAL: ${d.netwatchError}`);
                  } else if (body.ipAddress) {
                    toast.ok(`Device "${d.name}" dibuat + Netwatch terpasang di router ✓`);
                  } else {
                    toast.ok(`Device "${d.name}" dibuat ✓`);
                  }
                },
                onError: (e) => toast.error(`Gagal membuat device: ${(e as Error).message}`),
              })
            }
            onDelete={async (id) => {
              const target = selected;
              const ok = await confirm({
                title: 'Hapus device?',
                body: target
                  ? `${target.name} akan dihapus. Netwatch entry-nya juga dilepas dari router.`
                  : undefined,
                confirmLabel: 'Hapus',
                danger: true,
              });
              if (ok) {
                remove.mutate(id, {
                  onSuccess: () => { setSelected(null); toast.ok('Device dihapus'); },
                  onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
                });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
