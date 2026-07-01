'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AddressListEntry,
  AppUserPublic,
  AuditLogPage,
  Area,
  CreateDeviceInput,
  CreateRuijieAccountInput,
  BlockIntent,
  Device,
  DhcpLeaseDTO,
  FirewallBlockRule,
  SimpleQueueDTO,
  PatchDevicePositionInput,
  RouterPublic,
  RuijieAccountPublic,
  RuijieProjectDTO,
  RuijieRouterPublic,
  RuijieStationDTO,
  Site,
  SiteSummary,
  SiteWifiMap,
  UpdateDeviceInput,
  WsServerEvent,
} from '@noc/shared';
import { api } from './api';

export const qk = {
  sites: ['sites'] as const,
  site: (id: string) => ['site', id] as const,
  siteDevices: (id: string) => ['site', id, 'devices'] as const,
  siteSummary: (id: string) => ['site', id, 'summary'] as const,
  siteWifi: (id: string) => ['site', id, 'wifi'] as const,
  siteAreas: (id: string) => ['site', id, 'areas'] as const,
  routers: (siteId?: string) => ['routers', siteId ?? 'all'] as const,
  users: ['users'] as const,
  ruijieRouters: ['ruijie', 'routers'] as const,
  ruijieAccounts: ['ruijie', 'accounts'] as const,
  ruijieClients: (id: string) => ['ruijie', 'routers', id, 'clients'] as const,
  ruijieProjects: (accountId: string) => ['ruijie', 'accounts', accountId, 'projects'] as const,
  firewallBlocks: (routerId: string) => ['firewall', routerId, 'blocks'] as const,
  addressList: (routerId: string, list: string) => ['firewall', routerId, 'address-list', list] as const,
  audit: (query: string) => ['audit', query] as const,
};

type WriteResult = { ok: boolean; backup: 'saved' | 'failed' };

export function useFirewallBlocks(routerId: string | null) {
  return useQuery({
    queryKey: qk.firewallBlocks(routerId ?? ''),
    queryFn: () => api.get<FirewallBlockRule[]>(`/firewall/${routerId}/blocks`),
    enabled: Boolean(routerId),
    refetchInterval: 30_000,
  });
}
export function useToggleBlock(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ruleId: string; active: boolean }) =>
      api.post<WriteResult>(`/firewall/${routerId}/blocks/${encodeURIComponent(v.ruleId)}/toggle`, {
        active: v.active,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.firewallBlocks(routerId) }),
  });
}
export function useAddressList(routerId: string | null, list: string | null) {
  return useQuery({
    queryKey: qk.addressList(routerId ?? '', list ?? 'all'),
    queryFn: () =>
      api.get<AddressListEntry[]>(
        `/firewall/${routerId}/address-list${list ? `?list=${encodeURIComponent(list)}` : ''}`,
      ),
    enabled: Boolean(routerId),
    refetchInterval: 30_000,
  });
}
export function useAddAddressEntry(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { list: string; address: string; comment?: string }) =>
      api.post<WriteResult>(`/firewall/${routerId}/address-list`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['firewall', routerId, 'address-list'] }),
  });
}
export function useRemoveAddressEntry(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) =>
      api.del<WriteResult>(`/firewall/${routerId}/address-list/${encodeURIComponent(entryId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['firewall', routerId, 'address-list'] }),
  });
}

// ---- Managed block intents --------------------------------------------------
export function useBlockIntents(routerId: string | null) {
  return useQuery({
    queryKey: ['firewall', routerId, 'intents'],
    queryFn: () => api.get<BlockIntent[]>(`/firewall/${routerId}/intents`),
    enabled: Boolean(routerId),
    refetchInterval: 30_000,
  });
}
export function useCreateIntent(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { service: string; group?: string }) =>
      api.post<WriteResult>(`/firewall/${routerId}/intents`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['firewall', routerId, 'intents'] }),
  });
}
export function useToggleIntent(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ruleId: string; active: boolean }) =>
      api.post<WriteResult>(`/firewall/${routerId}/intents/${encodeURIComponent(v.ruleId)}/toggle`, {
        active: v.active,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['firewall', routerId, 'intents'] }),
  });
}
export function useRemoveIntent(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) =>
      api.del<WriteResult>(`/firewall/${routerId}/intents/${encodeURIComponent(ruleId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['firewall', routerId, 'intents'] }),
  });
}

// ---- Bandwidth / QoS --------------------------------------------------------
export function useSimpleQueues(routerId: string | null) {
  return useQuery({
    queryKey: ['bandwidth', routerId, 'queues'],
    queryFn: () => api.get<SimpleQueueDTO[]>(`/bandwidth/${routerId}/queues`),
    enabled: Boolean(routerId),
    refetchInterval: 15_000,
  });
}
export function useDhcpLeases(routerId: string | null) {
  return useQuery({
    queryKey: ['bandwidth', routerId, 'leases'],
    queryFn: () => api.get<DhcpLeaseDTO[]>(`/bandwidth/${routerId}/leases`),
    enabled: Boolean(routerId),
    refetchInterval: 30_000,
  });
}
export function useAddQueue(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; target: string; maxLimit: string }) =>
      api.post<WriteResult>(`/bandwidth/${routerId}/queues`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bandwidth', routerId, 'queues'] }),
  });
}
export function useSetQueueMax(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { qid: string; maxLimit: string }) =>
      api.patch<WriteResult>(`/bandwidth/${routerId}/queues/${encodeURIComponent(v.qid)}`, {
        maxLimit: v.maxLimit,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bandwidth', routerId, 'queues'] }),
  });
}
export function useRemoveQueue(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (qid: string) =>
      api.del<WriteResult>(`/bandwidth/${routerId}/queues/${encodeURIComponent(qid)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bandwidth', routerId, 'queues'] }),
  });
}
export function useSetLeaseRate(routerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { lid: string; rateLimit: string }) =>
      api.patch<WriteResult>(`/bandwidth/${routerId}/leases/${encodeURIComponent(v.lid)}`, {
        rateLimit: v.rateLimit,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bandwidth', routerId, 'leases'] }),
  });
}

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
export function useSiteWifi(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.siteWifi(id ?? ''),
    queryFn: () => api.get<SiteWifiMap>(`/sites/${id}/wifi`),
    enabled: Boolean(id) && enabled,
    // Worker refreshes the cache every ~5 min; poll a bit faster so the drawer/map
    // reflect roaming without a manual reload.
    refetchInterval: 120_000,
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

// ---- Ruijie / Reyee Cloud ----------------------------------------------------
// Data is mirrored into our DB by the worker poller; the UI polls our API for
// fresh counts (the worker, not each browser, talks to Ruijie's rate-limited API).

export function useRuijieRouters(enabled = true) {
  return useQuery({
    queryKey: qk.ruijieRouters,
    queryFn: () => api.get<RuijieRouterPublic[]>('/ruijie/routers'),
    refetchInterval: 30_000,
    enabled,
  });
}
export function useRuijieAccounts() {
  return useQuery({
    queryKey: qk.ruijieAccounts,
    queryFn: () => api.get<RuijieAccountPublic[]>('/ruijie/accounts'),
  });
}
/** On-demand client drill-down for one router; live-refreshes only while open. */
export function useRuijieRouterClients(routerId: string | null) {
  return useQuery({
    queryKey: qk.ruijieClients(routerId ?? ''),
    queryFn: () => api.get<RuijieStationDTO[]>(`/ruijie/routers/${routerId}/clients`),
    enabled: Boolean(routerId),
    refetchInterval: routerId ? 60_000 : false,
  });
}
export function useCreateRuijieAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRuijieAccountInput) => api.post('/ruijie/accounts', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.ruijieAccounts }),
  });
}
export function useDeleteRuijieAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/ruijie/accounts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.ruijieAccounts }),
  });
}
/** Live-discover the account's projects (hits the Ruijie API; load only when the picker opens). */
export function useRuijieProjects(accountId: string | null) {
  return useQuery({
    queryKey: qk.ruijieProjects(accountId ?? ''),
    queryFn: () => api.get<RuijieProjectDTO[]>(`/ruijie/accounts/${accountId}/projects`),
    enabled: Boolean(accountId),
    staleTime: 0,
  });
}
/** Save the Ruijie project -> NOC site mapping (super_admin). */
export function useSaveRuijieSiteMap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; groupSiteMap: Record<string, string> }) =>
      api.put<RuijieAccountPublic>(`/ruijie/accounts/${v.id}/site-map`, {
        groupSiteMap: v.groupSiteMap,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ruijieAccounts });
      qc.invalidateQueries({ queryKey: qk.ruijieRouters });
    },
  });
}

/** Save which projects the account monitors; backend re-polls so routers update at once. */
export function useSaveRuijieMonitored() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; monitoredGroupIds: string[] }) =>
      api.put<{ poll?: { devices?: number } }>(`/ruijie/accounts/${v.id}/projects`, {
        monitoredGroupIds: v.monitoredGroupIds,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.ruijieAccounts });
      qc.invalidateQueries({ queryKey: qk.ruijieRouters });
    },
  });
}

// ---- Audit log ---------------------------------------------------------------

/** Paginated audit trail (super_admin). Keeps the prior page visible while the
 *  next loads so paging/filtering doesn't flash a spinner. */
export function useAuditLog(
  params: { page: number; pageSize?: number; action?: string; entity?: string },
  enabled = true,
) {
  const qs = new URLSearchParams({ page: String(params.page) });
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.action) qs.set('action', params.action);
  if (params.entity) qs.set('entity', params.entity);
  const query = qs.toString();
  return useQuery({
    queryKey: qk.audit(query),
    queryFn: () => api.get<AuditLogPage>(`/audit?${query}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Apply a realtime event into the query cache (granular, per-device updates). */
export function applyWsEvent(qc: QueryClient, ev: WsServerEvent): void {
  const upd = (siteId: string, fn: (old: Device[] | undefined) => Device[] | undefined) =>
    qc.setQueryData<Device[]>(qk.siteDevices(siteId), fn);
  // Any device change can shift the site's up/down/unknown/maintenance counts.
  // The backend also pushes an explicit `site.summary`, but invalidating here
  // keeps the header KPIs honest even if that event is dropped or arrives out of
  // order — otherwise the map can show a red marker while the header says 0 down.
  const touchSummary = (siteId: string) =>
    void qc.invalidateQueries({ queryKey: qk.siteSummary(siteId) });

  switch (ev.type) {
    case 'device.status':
      upd(ev.siteId, (old) =>
        old?.map((d) =>
          d.id === ev.deviceId ? { ...d, status: ev.status, statusSince: ev.statusSince } : d,
        ),
      );
      touchSummary(ev.siteId);
      break;
    case 'device.updated':
      upd(ev.siteId, (old) => old?.map((d) => (d.id === ev.deviceId ? ev.device : d)));
      touchSummary(ev.siteId);
      break;
    case 'device.created':
      // Dedup by id: the creating client already appended via the mutation's
      // onSuccess, so the broadcast echo must not add a second copy.
      upd(ev.siteId, (old) =>
        old?.some((d) => d.id === ev.device.id) ? old : [...(old ?? []), ev.device],
      );
      touchSummary(ev.siteId);
      break;
    case 'device.deleted':
      upd(ev.siteId, (old) => old?.filter((d) => d.id !== ev.deviceId));
      touchSummary(ev.siteId);
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
