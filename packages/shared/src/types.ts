// =============================================================================
// Core enums & read-model (DTO) types shared between backend, worker, frontend.
// Isomorphic: must NOT import any node-only modules.
// =============================================================================

export const ROLES = ['viewer', 'operator', 'super_admin'] as const;
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
  /** Operator that acknowledged the current incident, if any. */
  ackBy: string | null;
  ackAt: string | null;
  /** Alerts suppressed until this moment (ISO). */
  silencedUntil: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single row in the global status-event timeline (joined view). */
export interface StatusEventRow {
  id: string;
  deviceId: string;
  deviceName: string;
  siteId: string;
  siteName: string;
  isCritical: boolean;
  oldStatus: DeviceStatus;
  newStatus: DeviceStatus;
  source: 'webhook' | 'polling' | 'manual';
  occurredAt: string;
}

/** An open incident — a device currently down, with workflow state. */
export interface Incident {
  deviceId: string;
  deviceName: string;
  siteId: string;
  siteName: string;
  isCritical: boolean;
  status: DeviceStatus;
  statusSince: string | null;
  durationSec: number;
  ackBy: string | null;
  ackAt: string | null;
  silencedUntil: string | null;
}

/** A row in the audit log viewer. */
export interface AuditLogRow {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
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
  // Netwatch tuning + custom RouterOS script tail (appended after the NOC
  // webhook fetch). Empty = no extra commands.
  netwatchIntervalSec: number;
  netwatchTimeoutMs: number;
  netwatchExtraUp: string | null;
  netwatchExtraDown: string | null;
  // Telegram message templates with {device} {ip} {site} {status} {when}
  telegramDownTemplate: string;
  telegramUpTemplate: string;
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
  'packets-in'?: string;
  'packets-out'?: string;
  'idle-time'?: string;
  'session-time-left'?: string;
  'login-by'?: string;
  server?: string;
}

// ---- Firewall / access control (block toggles + block address-lists) --------

/** A forward drop/reject firewall rule surfaced as a friendly on/off "block". */
export interface FirewallBlockRule {
  id: string; // RouterOS .id
  comment: string; // friendly name from the rule comment ('' if unnamed)
  action: string; // drop | reject
  active: boolean; // true = block is ON (rule enabled)
  method: string; // human description: "Layer7: WA", "List: 001 → non-lokal", …
}

/** One entry in a firewall address-list (used to block/allow a device or subnet). */
export interface AddressListEntry {
  id: string;
  list: string;
  address: string;
  comment: string | null;
  dynamic: boolean; // dynamic entries are read-only (can't be removed by us)
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

// ---- Ruijie / Reyee Cloud (read models) --------------------------------------

/** A Reyee router/AP, polled from Ruijie Cloud (status + connected-client count). */
export interface RuijieRouterPublic {
  id: string;
  accountId: string;
  cloudSerial: string;
  cloudGroupId: string; // BUILDING group — used for the client drill-down
  groupName: string; // project/room, for grouping in the UI
  siteId: string | null; // NOC Site this router's project is mapped to (or null)
  name: string;
  model: string | null;
  online: boolean;
  clientCount: number; // staNums
  activeClients: number; // staActiveNums
  localIp: string | null;
  wanIp: string | null;
  mac: string | null;
  firmware: string | null;
  lastSeenAt: string | null;
  updatedAt: string;
}

/** A Ruijie Cloud account (creds never exposed — only `hasAppSecret`). */
export interface RuijieAccountPublic {
  id: string;
  label: string;
  appId: string;
  baseUrl: string;
  pollIntervalSec: number | null;
  hasAppSecret: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
  routerCount: number;
  /** Ruijie group_ids this account monitors. Empty = nothing selected yet. */
  monitoredGroupIds: string[];
  /** Map of Ruijie project (keyed by groupName) -> NOC siteId. */
  groupSiteMap: Record<string, string>;
  createdAt: string;
}

/**
 * A Ruijie project/group discovered live from the account, for the super_admin's
 * monitor-allowlist picker. The personal account mixes many sites (factory, home,
 * school); the admin ticks only the ones the NOC should monitor (e.g. the school).
 */
export interface RuijieProjectDTO {
  groupId: string;
  groupName: string;
  deviceCount: number;
  onlineCount: number;
  clientCount: number;
  monitored: boolean; // already in the account's allowlist
}

/** One connected client station (on-demand drill-down for a router). */
export interface RuijieStationDTO {
  mac: string;
  ip: string | null;
  hostname: string | null;
  apName: string | null;
  apSerial: string | null;
  ssid: string | null;
  band: string | null;
  rssi: number | null;
  channel: string | null;
  flowUp: number | null;
  flowDown: number | null;
  onlineSince: number | null;
  manufacturer: string | null;
  os: string | null;
  category: string | null;
}

// ---- Device ⇄ WiFi correlation (worker-built, read-only on the site page) -----

/** The WiFi AP a registered NOC device is currently connected to, resolved by
 *  matching the device's IP to a Ruijie client station (strongest RSSI wins). */
export interface DeviceWifiLink {
  apName: string | null; // serving Ruijie AP, e.g. "ASS-IN-A"
  ssid: string | null;
  band: string | null; // "2.4G" | "5G"
  rssi: number | null; // dBm (negative; closer to 0 = stronger)
  hostname: string | null;
  mac: string;
  onlineSince: number | null; // epoch ms
}

/** Cached per-site correlation: deviceId → its current WiFi link. */
export interface SiteWifiMap {
  updatedAt: string | null; // ISO; null when nothing cached yet
  links: Record<string, DeviceWifiLink>;
}

// ---- Audit log (super_admin activity trail) ---------------------------------

/** One audit-trail entry with the acting user joined (null if system/deleted). */
export interface AuditLogPublic {
  id: string;
  createdAt: string;
  action: string;
  entity: string;
  entityId: string | null;
  ip: string | null;
  user: { id: string; name: string; email: string; role: Role } | null;
  before: unknown;
  after: unknown;
}

/** Paginated audit response + filter facets (distinct entities/actions). */
export interface AuditLogPage {
  items: AuditLogPublic[];
  total: number;
  page: number;
  pageSize: number;
  facets: { entities: string[]; actions: string[] };
}
