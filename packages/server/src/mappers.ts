// =============================================================================
// Map Prisma rows -> API DTOs (camelCase, ISO dates, no secrets).
// =============================================================================

import type {
  AppUserPublic,
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
  Site as SiteDTO,
  TelegramMode,
} from '@noc/shared';
import type {
  AppUser,
  Area,
  Company,
  Device,
  Line,
  RouterMikrotik,
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
