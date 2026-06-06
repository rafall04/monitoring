// =============================================================================
// Core enums & read-model (DTO) types shared between backend, worker, frontend.
// Isomorphic: must NOT import any node-only modules.
// =============================================================================

export const ROLES = ['user', 'operator', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];

/** Real status as reported by Netwatch. */
export const DEVICE_STATUSES = ['up', 'down', 'unknown'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const ROUTER_STATUSES = ['online', 'offline', 'unknown'] as const;
export type RouterStatus = (typeof ROUTER_STATUSES)[number];

export const MAP_MODES = ['geo', 'floorplan'] as const;
export type MapMode = (typeof MAP_MODES)[number];

export const ROUTEROS_VERSIONS = ['v6', 'v7'] as const;
export type RouterOsVersion = (typeof ROUTEROS_VERSIONS)[number];

/** Where a status change came from. */
export const STATUS_SOURCES = ['webhook', 'polling', 'manual'] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];

/** Manual override flags a device so it does not raise alarms (e.g. maintenance). */
export const MANUAL_OVERRIDES = ['maintenance'] as const;
export type ManualOverride = (typeof MANUAL_OVERRIDES)[number];

export const DEVICE_TYPES = [
  'router',
  'switch',
  'access_point',
  'onu',
  'olt',
  'server',
  'cctv',
  'tower',
  'antenna',
  'pc',
  'printer',
  'gtex', // production data terminal on the line
  'qcpad', // QC tablet
  'androidtv', // andon / monitoring display
  'other',
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const AREA_KINDS = ['lines', 'room'] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

export const TELEGRAM_MODES = ['off', 'server', 'router'] as const;
export type TelegramMode = (typeof TELEGRAM_MODES)[number];

/** Status used for rendering markers (real status combined with overrides). */
export type DisplayStatus = DeviceStatus | 'maintenance' | 'warning';

export const STATUS_COLORS: Record<DisplayStatus, string> = {
  up: '#22c55e', // green
  down: '#ef4444', // red
  unknown: '#9ca3af', // grey
  maintenance: '#3b82f6', // blue
  warning: '#eab308', // yellow
};

/** Short accessible label/abbreviation so status is not conveyed by colour alone. */
export const STATUS_LABELS: Record<DisplayStatus, string> = {
  up: 'UP',
  down: 'DOWN',
  unknown: '???',
  maintenance: 'MNT',
  warning: 'WARN',
};

/**
 * Combine a device's real status with its manual override to get the status
 * actually shown on the map. A maintenance override always wins so flapping
 * hosts under maintenance never raise a red alarm.
 */
export function effectiveStatus(
  status: DeviceStatus,
  override?: ManualOverride | null,
): DisplayStatus {
  if (override === 'maintenance') return 'maintenance';
  return status;
}

// ---- Read models (what the REST API returns; camelCase, no secrets) ----------

export interface Company {
  id: string;
  name: string;
  createdAt: string;
}

/** image bounds for CRS.Simple floorplans: [[y0,x0],[y1,x1]] (usually [[0,0],[h,w]]). */
export type ImageBounds = [[number, number], [number, number]];

export interface Site {
  id: string;
  companyId: string;
  name: string;
  region: string | null;
  mapMode: MapMode;
  floorplanImageUrl: string | null;
  floorplanWidth: number | null;
  floorplanHeight: number | null;
  imageBounds: ImageBounds | null;
  geoCenterLat: number | null;
  geoCenterLng: number | null;
  defaultZoom: number;
  telegramMode: TelegramMode;
  telegramChatId: string | null;
  hasTelegramToken: boolean;
  createdAt: string;
}

export interface Line {
  id: string;
  areaId: string;
  name: string;
  orderIndex: number;
  createdAt: string;
}

export interface Area {
  id: string;
  siteId: string;
  name: string;
  kind: AreaKind;
  orderIndex: number;
  createdAt: string;
  lines: Line[];
}

export interface RouterResource {
  identity?: string;
  uptime?: string;
  cpuLoad?: number;
  freeMemory?: number;
  totalMemory?: number;
  version?: string;
  boardName?: string;
}

/** Router as exposed to clients. The encrypted password is NEVER included. */
export interface RouterPublic {
  id: string;
  siteId: string;
  name: string;
  host: string;
  apiPort: number;
  useTls: boolean;
  username: string;
  routerosVersion: RouterOsVersion;
  pollIntervalSec: number | null;
  status: RouterStatus;
  lastSeenAt: string | null;
  resourceCache: RouterResource | null;
  hasWebhookToken: boolean;
  createdAt: string;
}

export interface Device {
  id: string;
  routerId: string;
  siteId: string;
  areaId: string | null;
  lineId: string | null;
  orderIndex: number;
  name: string;
  ipAddress: string | null;
  type: DeviceType;
  iconKey: string | null;
  iconUrl: string | null;
  geoLat: number | null;
  geoLng: number | null;
  mapX: number | null;
  mapY: number | null;
  status: DeviceStatus;
  statusSince: string | null;
  manualOverride: ManualOverride | null;
  netwatchSynced: boolean;
  isCritical: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DownDevice {
  deviceId: string;
  name: string;
  since: string | null;
}

export interface SiteSummary {
  siteId: string;
  total: number;
  up: number;
  down: number;
  unknown: number;
  maintenance: number;
  availabilityPct: number;
  currentlyDown: DownDevice[];
}

export interface AppUserPublic {
  id: string;
  name: string;
  email: string;
  role: Role;
  scopeSiteIds: string[];
  isActive: boolean;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthSession extends AuthTokens {
  user: AppUserPublic;
}

// ---- Settings / Branding -----------------------------------------------------

/** White-label fields exposed without auth (login page needs them). */
export interface BrandingPublic {
  orgName: string;
  logoUrl: string | null;
  accentRgb: string; // "R G B" channel triplet
  themeDefault: 'dark' | 'light';
}

/** Full settings (super_admin only). */
export interface Settings extends BrandingPublic {
  defaultMapLat: number;
  defaultMapLng: number;
  defaultMapZoom: number;
  defaultPollSec: number;
  eventRetentionDays: number;
  auditRetentionDays: number;
  updatedAt: string;
}

// ---- Hotspot read models (fetched live from MikroTik, not mirrored in DB) -----

export interface HotspotUser {
  '.id'?: string;
  name: string;
  password?: string;
  profile?: string;
  server?: string;
  'limit-uptime'?: string;
  'limit-bytes-total'?: string;
  uptime?: string;
  'bytes-in'?: string;
  'bytes-out'?: string;
  comment?: string;
  disabled?: string;
}

export interface HotspotActive {
  '.id'?: string;
  user?: string;
  address?: string;
  'mac-address'?: string;
  uptime?: string;
  'bytes-in'?: string;
  'bytes-out'?: string;
  server?: string;
}

export interface HotspotProfile {
  '.id'?: string;
  name: string;
  'rate-limit'?: string;
  'shared-users'?: string;
  'session-timeout'?: string;
}

export interface VoucherRow {
  username: string;
  password: string;
  profile?: string;
}
