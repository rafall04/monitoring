// =============================================================================
// Map Prisma rows -> API DTOs (camelCase, ISO dates, no secrets).
// =============================================================================

import type {
  AppUserPublic,
  AuditLogPublic,
  Area as AreaDTO,
  AreaKind,
  Company as CompanyDTO,
  Device as DeviceDTO,
  DeviceStatus,
  DeviceType,
  ImageBounds,
  Line as LineDTO,
  ManualOverride,
  MapMode,
  RouterOsVersion,
  RouterPublic,
  RouterResource,
  RouterStatus,
  Role,
  RuijieAccountPublic,
  RuijieRouterPublic,
  Site as SiteDTO,
  TelegramMode,
} from '@noc/shared';
import type {
  AppUser,
  AuditLog,
  Area,
  Company,
  Device,
  Line,
  RouterMikrotik,
  RuijieAccount,
  RuijieRouter,
  Site,
} from '@prisma/client';

export function toCompanyDto(c: Company): CompanyDTO {
  return { id: c.id, name: c.name, createdAt: c.createdAt.toISOString() };
}

export function toSiteDto(s: Site): SiteDTO {
  return {
    id: s.id,
    companyId: s.companyId,
    name: s.name,
    region: s.region,
    mapMode: s.mapMode as MapMode,
    floorplanImageUrl: s.floorplanImageUrl,
    floorplanWidth: s.floorplanWidth,
    floorplanHeight: s.floorplanHeight,
    imageBounds: (s.imageBounds as ImageBounds | null) ?? null,
    geoCenterLat: s.geoCenterLat,
    geoCenterLng: s.geoCenterLng,
    defaultZoom: s.defaultZoom,
    telegramMode: s.telegramMode as TelegramMode,
    telegramChatId: s.telegramChatId,
    hasTelegramToken: Boolean(s.telegramBotEncrypted),
    createdAt: s.createdAt.toISOString(),
  };
}

export function toRouterPublic(r: RouterMikrotik): RouterPublic {
  return {
    id: r.id,
    siteId: r.siteId,
    name: r.name,
    host: r.host,
    apiPort: r.apiPort,
    useTls: r.useTls,
    username: r.username,
    routerosVersion: r.routerosVersion as RouterOsVersion,
    pollIntervalSec: r.pollIntervalSec,
    status: r.status as RouterStatus,
    lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    resourceCache: (r.resourceCache as RouterResource | null) ?? null,
    hasWebhookToken: Boolean(r.webhookToken),
    createdAt: r.createdAt.toISOString(),
  };
}

export function toDeviceDto(d: Device): DeviceDTO {
  return {
    id: d.id,
    routerId: d.routerId,
    siteId: d.siteId,
    areaId: d.areaId,
    lineId: d.lineId,
    orderIndex: d.orderIndex,
    name: d.name,
    ipAddress: d.ipAddress,
    type: d.type as DeviceType,
    iconKey: d.iconKey,
    iconUrl: d.iconUrl,
    geoLat: d.geoLat,
    geoLng: d.geoLng,
    mapX: d.mapX,
    mapY: d.mapY,
    status: d.status as DeviceStatus,
    statusSince: d.statusSince ? d.statusSince.toISOString() : null,
    manualOverride: (d.manualOverride as ManualOverride | null) ?? null,
    netwatchSynced: d.netwatchSynced,
    isCritical: d.isCritical,
    ackBy: d.ackBy ?? null,
    ackAt: d.ackAt ? d.ackAt.toISOString() : null,
    silencedUntil: d.silencedUntil ? d.silencedUntil.toISOString() : null,
    note: d.note,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function toAppUserPublic(u: AppUser): AppUserPublic {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as Role,
    scopeSiteIds: (u.scopeSiteIds as string[] | null) ?? [],
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
  };
}

export function toLineDto(l: Line): LineDTO {
  return {
    id: l.id,
    areaId: l.areaId,
    name: l.name,
    orderIndex: l.orderIndex,
    createdAt: l.createdAt.toISOString(),
  };
}

export function toAreaDto(a: Area & { lines?: Line[] }): AreaDTO {
  return {
    id: a.id,
    siteId: a.siteId,
    name: a.name,
    kind: a.kind as AreaKind,
    orderIndex: a.orderIndex,
    createdAt: a.createdAt.toISOString(),
    lines: (a.lines ?? []).map(toLineDto),
  };
}

export function toRuijieRouterPublic(
  r: RuijieRouter,
  siteId: string | null = null,
): RuijieRouterPublic {
  return {
    id: r.id,
    accountId: r.accountId,
    cloudSerial: r.cloudSerial,
    cloudGroupId: r.cloudGroupId,
    groupName: r.groupName,
    siteId,
    name: r.name,
    model: r.model,
    online: r.online,
    clientCount: r.clientCount,
    activeClients: r.activeClients,
    localIp: r.localIp,
    wanIp: r.wanIp,
    mac: r.mac,
    firmware: r.firmware,
    lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toRuijieAccountPublic(a: RuijieAccount, routerCount = 0): RuijieAccountPublic {
  return {
    id: a.id,
    label: a.label,
    appId: a.appId,
    baseUrl: a.baseUrl,
    pollIntervalSec: a.pollIntervalSec,
    hasAppSecret: Boolean(a.appSecretEncrypted),
    lastPolledAt: a.lastPolledAt ? a.lastPolledAt.toISOString() : null,
    lastError: a.lastError,
    routerCount,
    monitoredGroupIds: a.monitoredGroupIds,
    groupSiteMap: (a.groupSiteMap as Record<string, string> | null) ?? {},
    createdAt: a.createdAt.toISOString(),
  };
}

export function toAuditLogPublic(a: AuditLog & { user: AppUser | null }): AuditLogPublic {
  return {
    id: a.id,
    createdAt: a.createdAt.toISOString(),
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    ip: a.ip,
    user: a.user
      ? { id: a.user.id, name: a.user.name, email: a.user.email, role: a.user.role as Role }
      : null,
    before: a.before ?? null,
    after: a.after ?? null,
  };
}
