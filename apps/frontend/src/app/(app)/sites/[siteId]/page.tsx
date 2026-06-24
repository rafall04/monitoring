'use client';

import { useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
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
  useRuijieRouters,
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
import { Button, ErrorState, Legend, Page, PageHeader, Spinner, Tabs } from '@/components/ui';

// Leaflet touches `window`, so the map must be client-only.
const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <Spinner label="Loading map…" />
    </div>
  ),
});

const VIEW_TABS: { value: 'line' | 'denah'; label: string }[] = [
  { value: 'line', label: 'Line / Area' },
  { value: 'denah', label: 'Denah' },
];

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
  const ruijie = useRuijieRouters(can('ruijie:view'));

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

  // A failed fetch must not be mistaken for "not found / no access" below — show
  // a distinct error with retry so a server/network problem is diagnosable.
  if (site.isError || devices.isError)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState
          onRetry={() => {
            void site.refetch();
            void devices.refetch();
          }}
        >
          Gagal memuat data site. Coba lagi, atau pastikan Anda punya akses.
        </ErrorState>
      </div>
    );
  if (site.isLoading || devices.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (!site.data)
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        Site not found or you do not have access.
      </div>
    );

  const s = summary.data;
  // Ruijie WiFi linked to this site (projects mapped via groupSiteMap).
  const wifiRouters = (ruijie.data ?? []).filter((r) => r.siteId === siteId);
  const wifiClients = wifiRouters.reduce((n, r) => n + r.clientCount, 0);
  const wifiOnline = wifiRouters.filter((r) => r.online).length;
  const wifiGroups = [...new Set(wifiRouters.map((r) => r.groupName))];
  const wifiHref = wifiGroups.length === 1 ? `/ruijie/${encodeURIComponent(wifiGroups[0]!)}` : '/ruijie';

  return (
    <Page>
      <PageHeader
        width="full"
        title={site.data.name}
        subtitle={`${site.data.region ? `${site.data.region} · ` : ''}${devices.data?.length ?? 0} devices`}
        actions={
          <div className="flex flex-wrap items-center gap-4">
          {s && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-emerald-400">{s.up} up</span>
              <span className="text-red-400">{s.down} down</span>
              <span className="text-slate-400">{s.unknown} ?</span>
              <span className="font-semibold text-slate-100">{s.availabilityPct}%</span>
            </div>
          )}
          {can('ruijie:view') && wifiRouters.length > 0 && (
            <Link
              href={wifiHref}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-sm font-medium text-accent transition hover:bg-accent/25"
              title="WiFi Ruijie di site ini"
            >
              <WifiIcon />
              {wifiClients} client · {wifiOnline}/{wifiRouters.length} AP
            </Link>
          )}
          <Tabs tabs={VIEW_TABS} value={tab} onChange={setTab} />
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
        }
      />

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
    </Page>
  );
}

function WifiIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.55a11 11 0 0 1 14 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}
