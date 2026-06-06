'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AppUserPublic,
  Area,
  CreateDeviceInput,
  Device,
  PatchDevicePositionInput,
  RouterPublic,
  Site,
  SiteSummary,
  UpdateDeviceInput,
  WsServerEvent,
} from '@noc/shared';
import { api } from './api';

export const qk = {
  sites: ['sites'] as const,
  site: (id: string) => ['site', id] as const,
  siteDevices: (id: string) => ['site', id, 'devices'] as const,
  siteSummary: (id: string) => ['site', id, 'summary'] as const,
  siteAreas: (id: string) => ['site', id, 'areas'] as const,
  routers: (siteId?: string) => ['routers', siteId ?? 'all'] as const,
  users: ['users'] as const,
};

export function useSites() {
  return useQuery({ queryKey: qk.sites, queryFn: () => api.get<Site[]>('/sites') });
}
export function useSite(id: string | undefined) {
  return useQuery({
    queryKey: qk.site(id ?? ''),
    queryFn: () => api.get<Site>(`/sites/${id}`),
    enabled: Boolean(id),
  });
}
export function useSiteDevices(id: string | undefined) {
  return useQuery({
    queryKey: qk.siteDevices(id ?? ''),
    queryFn: () => api.get<Device[]>(`/sites/${id}/devices`),
    enabled: Boolean(id),
  });
}
export function useSiteSummary(id: string | undefined) {
  return useQuery({
    queryKey: qk.siteSummary(id ?? ''),
    queryFn: () => api.get<SiteSummary>(`/sites/${id}/summary`),
    enabled: Boolean(id),
  });
}
export function useRouters(siteId?: string) {
  return useQuery({
    queryKey: qk.routers(siteId),
    queryFn: () => api.get<RouterPublic[]>(`/routers${siteId ? `?siteId=${siteId}` : ''}`),
  });
}
export function useAppUsers() {
  return useQuery({ queryKey: qk.users, queryFn: () => api.get<AppUserPublic[]>('/users') });
}

/** Apply a realtime event into the query cache (granular, per-device updates). */
export function applyWsEvent(qc: QueryClient, ev: WsServerEvent): void {
  const upd = (siteId: string, fn: (old: Device[] | undefined) => Device[] | undefined) =>
    qc.setQueryData<Device[]>(qk.siteDevices(siteId), fn);

  switch (ev.type) {
    case 'device.status':
      upd(ev.siteId, (old) =>
        old?.map((d) =>
          d.id === ev.deviceId ? { ...d, status: ev.status, statusSince: ev.statusSince } : d,
        ),
      );
      break;
    case 'device.updated':
      upd(ev.siteId, (old) => old?.map((d) => (d.id === ev.deviceId ? ev.device : d)));
      break;
    case 'device.created':
      upd(ev.siteId, (old) => (old ? [...old, ev.device] : [ev.device]));
      break;
    case 'device.deleted':
      upd(ev.siteId, (old) => old?.filter((d) => d.id !== ev.deviceId));
      break;
    case 'site.summary':
      qc.setQueryData(qk.siteSummary(ev.siteId), ev.summary);
      break;
    default:
      break;
  }
}

// ---- device mutations --------------------------------------------------------

export function useMoveDevice(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; pos: PatchDevicePositionInput }) =>
      api.patch<Device>(`/devices/${v.id}/position`, v.pos),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.siteDevices(siteId) });
      const prev = qc.getQueryData<Device[]>(qk.siteDevices(siteId));
      qc.setQueryData<Device[]>(qk.siteDevices(siteId), (old) =>
        old?.map((d) => (d.id === v.id ? { ...d, ...v.pos } : d)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.siteDevices(siteId), ctx.prev);
    },
  });
}

// Create/update may include a transient `netwatchError` hint when a Netwatch
// (re)install was requested but failed — the device itself is still saved.
export type DeviceWithNetwatch = Device & { netwatchError?: string };

export function useUpdateDevice(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: UpdateDeviceInput }) =>
      api.patch<DeviceWithNetwatch>(`/devices/${v.id}`, v.patch),
    onSuccess: (d) =>
      qc.setQueryData<Device[]>(qk.siteDevices(siteId), (old) =>
        old?.map((x) => (x.id === d.id ? d : x)),
      ),
  });
}

export function useCreateDevice(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDeviceInput) => api.post<DeviceWithNetwatch>('/devices', body),
    onSuccess: (d) =>
      qc.setQueryData<Device[]>(qk.siteDevices(siteId), (old) => (old ? [...old, d] : [d])),
  });
}

export function useDeleteDevice(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/devices/${id}`),
    onSuccess: (_r, id) =>
      qc.setQueryData<Device[]>(qk.siteDevices(siteId), (old) => old?.filter((d) => d.id !== id)),
  });
}

// ---- area / line structure ---------------------------------------------------

export function useSiteAreas(id: string | undefined) {
  return useQuery({
    queryKey: qk.siteAreas(id ?? ''),
    queryFn: () => api.get<Area[]>(`/sites/${id}/areas`),
    enabled: Boolean(id),
  });
}

export function useAreaMutations(siteId: string) {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.siteAreas(siteId) });
  const invAll = () => {
    inv();
    qc.invalidateQueries({ queryKey: qk.siteDevices(siteId) });
  };
  return {
    createArea: useMutation({
      mutationFn: (v: { name: string; kind: 'lines' | 'room' }) => api.post('/areas', { siteId, ...v }),
      onSuccess: inv,
    }),
    renameArea: useMutation({
      mutationFn: (v: { id: string; name: string }) => api.patch(`/areas/${v.id}`, { name: v.name }),
      onSuccess: inv,
    }),
    deleteArea: useMutation({ mutationFn: (id: string) => api.del(`/areas/${id}`), onSuccess: invAll }),
    createLine: useMutation({
      mutationFn: (v: { areaId: string; name: string }) => api.post('/lines', v),
      onSuccess: inv,
    }),
    renameLine: useMutation({
      mutationFn: (v: { id: string; name: string }) => api.patch(`/lines/${v.id}`, { name: v.name }),
      onSuccess: inv,
    }),
    deleteLine: useMutation({ mutationFn: (id: string) => api.del(`/lines/${id}`), onSuccess: invAll }),
  };
}

export function useAssignDevice(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; areaId?: string | null; lineId?: string | null }) =>
      api.patch<Device>(`/devices/${v.id}/assign`, { areaId: v.areaId, lineId: v.lineId }),
    onSuccess: (d) =>
      qc.setQueryData<Device[]>(qk.siteDevices(siteId), (old) =>
        old?.map((x) => (x.id === d.id ? d : x)),
      ),
  });
}

export function useReorderDevices(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.post('/devices/reorder', { ids }),
    onMutate: (ids) => {
      const prev = qc.getQueryData<Device[]>(qk.siteDevices(siteId));
      qc.setQueryData<Device[]>(qk.siteDevices(siteId), (old) =>
        old?.map((d) => {
          const i = ids.indexOf(d.id);
          return i >= 0 ? { ...d, orderIndex: i } : d;
        }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.siteDevices(siteId), ctx.prev);
    },
  });
}
