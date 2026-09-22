// =============================================================================
// Core enums & read-model (DTO) types shared between backend, worker, frontend.
// Isomorphic: must NOT import any node-only modules.
// =============================================================================

// 'member' = hotspot end-user: logs in with their hotspot username and only
// reaches the self-service /me/hotspot endpoints — no NOC permissions at all.
export const ROLES = ['viewer', 'operator', 'super_admin', 'member'] as const;
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
  /** member role: the hotspot username this account self-manages (null for staff). */
  hotspotUsername: string | null;
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
  'mac-address'?: string;
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

// ---- Member self-service (/me/hotspot) ---------------------------------------
// What a logged-in member sees about their own hotspot account. Everything is
// read live from their linked router — nothing is mirrored into the NOC DB.

export interface MemberHotspotStatus {
  username: string;
  profile: string; // effective profile on the router (may be a -ND device variant)
  devices: number; // simultaneous-login limit (shared-users on the user-profile)
  disabled: boolean;
  uptime: string | null;
  bytesIn: string | null;
  bytesOut: string | null;
  limitUptime: string | null;
  limitBytesTotal: string | null;
  /** Apps intentionally blocked for this user's access profile (blocklist). */
  blockedServices: { key: string; label: string }[];
  sessions: HotspotActive[]; // only this user's own active sessions
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

// ---- Managed block system (clean layer: noc-block chain + noc-svc/noc-grp) ---

/** One NOC-managed block intent = the SET of noc-block rules for a group × service
 *  (domain/IP address-list drop + tls-host SNI drops), aggregated into one on/off. */
export interface BlockIntent {
  id: string; // synthetic key '<group>|<service>' — addresses the whole rule set
  group: string; // 'semua' = all devices, else a noc-grp-<group> address-list
  service: string; // service key (whatsapp, tiktok, …) or 'internet'
  active: boolean; // true only when every rule in the set is enabled
}

/** A blockable service. `domains` seed the auto-resolving address-list; `sniGlobs`
 *  drive tls-host (SNI) drops that catch TLS by hostname regardless of the (rotating)
 *  IP; `ipRanges` are static CIDRs for no-SNI traffic (media/calls) of apps that own
 *  their ASN. The three layers + a global QUIC block are what actually holds. */
export interface BlockServiceDef {
  key: string;
  label: string;
  category: string; // for grouping in the UI
  domains: string[];
  sniGlobs?: string[]; // tls-host globs, e.g. '*whatsapp*' (emitted with protocol=tcp)
  ipRanges?: string[]; // static CIDRs (own-ASN apps: Meta, Telegram) for no-SNI traffic
}

/** Meta / AS32934 CIDRs — shared by WhatsApp + Facebook/Instagram; they cover the
 *  no-SNI media/edge servers WhatsApp falls back to (the exact leak seen on SF1).
 *  Static snapshot — refresh periodically (Meta publishes its prefix list). */
const META_CIDRS = [
  '157.240.0.0/16', '31.13.24.0/21', '31.13.64.0/18', '129.134.0.0/16', '173.252.64.0/18',
  '179.60.192.0/22', '185.60.216.0/22', '102.132.96.0/20', '69.171.224.0/19', '57.144.0.0/14',
  '66.220.144.0/20', '204.15.20.0/22',
];
/** Telegram AS62041/AS44907 CIDRs — Telegram runs its own ASN, so IP-range blocking
 *  is precise and needed for its no-SNI MTProto traffic. */
const TELEGRAM_CIDRS = [
  '91.108.4.0/22', '91.108.8.0/21', '91.108.16.0/21', '91.108.56.0/22', '91.105.192.0/23',
  '149.154.160.0/20', '185.76.151.0/24', '95.161.64.0/20',
];

/** Curated service catalog, grouped by category. Each toggle drops via three
 *  complementary layers on the router — domain/IP address-list, tls-host SNI, and a
 *  global QUIC (udp/443) block — instead of domains alone. Best-effort for apps that
 *  ride shared CDNs (games/streaming/WeChat), where an IP-range block would over-block
 *  so we rely on SNI + domains. */
export const BLOCK_SERVICES: BlockServiceDef[] = [
  // --- Sosial media ---
  { key: 'whatsapp', label: 'WhatsApp', category: 'Sosial media', domains: ['whatsapp.com', 'whatsapp.net', 'g.whatsapp.net', 'mmg.whatsapp.net'], sniGlobs: ['*whatsapp*'], ipRanges: META_CIDRS },
  { key: 'facebook', label: 'Facebook / Instagram', category: 'Sosial media', domains: ['facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'fb.com'], sniGlobs: ['*facebook*', '*fbcdn*', '*fbsbx*', '*instagram*', '*cdninstagram*'], ipRanges: META_CIDRS },
  { key: 'wechat', label: 'WeChat', category: 'Sosial media', domains: ['wechat.com', 'weixin.qq.com', 'wx.qq.com', 'wechatapp.com', 'weixinbridge.com'], sniGlobs: ['*wechat*', '*weixin*', '*tenpay*'] },
  { key: 'tiktok', label: 'TikTok', category: 'Sosial media', domains: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'byteoversea.com', 'ibytedtos.com', 'musical.ly'], sniGlobs: ['*tiktok*', '*byteoversea*', '*ibytedtos*', '*muscdn*', '*.musical.ly'] },
  { key: 'twitter', label: 'X / Twitter', category: 'Sosial media', domains: ['twitter.com', 'x.com', 't.co', 'twimg.com'], sniGlobs: ['*.twitter.com', '*.x.com', '*.t.co', '*twimg*'] },
  { key: 'telegram', label: 'Telegram', category: 'Sosial media', domains: ['telegram.org', 't.me', 'telegram.me', 'telegra.ph'], sniGlobs: ['*telegram*', '*.t.me', '*telegra.ph*'], ipRanges: TELEGRAM_CIDRS },
  { key: 'snapchat', label: 'Snapchat', category: 'Sosial media', domains: ['snapchat.com', 'sc-cdn.net', 'snap-dev.net'], sniGlobs: ['*snapchat*', '*sc-cdn*', '*snap-dev*'] },
  { key: 'line', label: 'LINE', category: 'Sosial media', domains: ['line.me', 'line-apps.com', 'line-scdn.net'], sniGlobs: ['*.line.me', '*line-apps*', '*line-scdn*'] },
  { key: 'discord', label: 'Discord', category: 'Sosial media', domains: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net'], sniGlobs: ['*discord*'] },
  // --- Kerja / kolaborasi ---
  // Teams/Zoom ride shared cloud ASNs (Azure/Cloudflare) — IP ranges would
  // over-block, so these rely on domains + SNI only (media is best-effort).
  { key: 'teams', label: 'Microsoft Teams', category: 'Kerja / kolaborasi', domains: ['teams.microsoft.com', 'teams.live.com', 'teams.ms', 'microsoftteams.com'], sniGlobs: ['*teams.microsoft*', '*microsoftteams*', '*teams.live*'] },
  { key: 'zoom', label: 'Zoom', category: 'Kerja / kolaborasi', domains: ['zoom.us', 'zoom.com', 'zoomgov.com'], sniGlobs: ['*zoom*'] },
  { key: 'meet', label: 'Google Meet', category: 'Kerja / kolaborasi', domains: ['meet.google.com'], sniGlobs: ['*meet.google*', '*googlemeet*'] },
  // --- Video / streaming ---
  { key: 'youtube', label: 'YouTube', category: 'Video / streaming', domains: ['youtube.com', 'youtu.be', 'youtubei.googleapis.com', 'ytimg.com', 'googlevideo.com'], sniGlobs: ['*.youtube.com', '*googlevideo*', '*ytimg*', '*.youtu.be', '*youtubei*'] },
  { key: 'netflix', label: 'Netflix', category: 'Video / streaming', domains: ['netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxext.com'], sniGlobs: ['*netflix*', '*nflxvideo*', '*nflximg*', '*nflxext*'] },
  { key: 'twitch', label: 'Twitch', category: 'Video / streaming', domains: ['twitch.tv', 'ttvnw.net', 'jtvnw.net'], sniGlobs: ['*twitch*', '*ttvnw*', '*jtvnw*'] },
  { key: 'spotify', label: 'Spotify', category: 'Video / streaming', domains: ['spotify.com', 'scdn.co', 'spotifycdn.com'], sniGlobs: ['*spotify*', '*.scdn.co', '*spotifycdn*'] },
  // --- Game ---
  { key: 'freefire', label: 'Free Fire / Garena', category: 'Game', domains: ['garena.com', 'ff.garena.com', 'freefiremobile.com'], sniGlobs: ['*garena*', '*freefire*'] },
  { key: 'mobilelegends', label: 'Mobile Legends', category: 'Game', domains: ['mobilelegends.com', 'mtghub.com'], sniGlobs: ['*mobilelegends*', '*mtghub*'] },
  { key: 'pubg', label: 'PUBG Mobile', category: 'Game', domains: ['pubgmobile.com', 'igamecj.com'], sniGlobs: ['*pubgmobile*', '*igamecj*'] },
  { key: 'roblox', label: 'Roblox', category: 'Game', domains: ['roblox.com', 'rbxcdn.com'], sniGlobs: ['*roblox*', '*rbxcdn*'] },
  { key: 'steam', label: 'Steam', category: 'Game', domains: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamcontent.com'], sniGlobs: ['*steampowered*', '*steamcommunity*', '*steamstatic*', '*steamcontent*'] },
  // --- Konten lain ---
  { key: 'adult', label: 'Konten dewasa (parsial)', category: 'Konten lain', domains: ['pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com'], sniGlobs: ['*pornhub*', '*xvideos*', '*xnxx*', '*xhamster*', '*redtube*'] },
];

// ---- Bandwidth / QoS (simple queues + DHCP lease rate-limit) -----------------

/** A RouterOS simple queue — the per-device/subnet bandwidth limit. */
export interface SimpleQueueDTO {
  id: string;
  name: string;
  target: string; // IP / subnet the limit applies to
  maxLimit: string; // "up/down", e.g. "2M/2M"; "0/0" = unlimited
  bytes: string; // cumulative "upBytes/downBytes" — used for top-talkers
  disabled: boolean;
  dynamic: boolean; // dynamic (e.g. hotspot-created) — read-only for us
  hotspot: boolean; // name looks like <hotspot-…> (managed via hotspot profiles)
}

/** A DHCP lease — can carry an optional per-device rate-limit. */
export interface DhcpLeaseDTO {
  id: string;
  address: string;
  macAddress: string;
  hostName: string | null;
  rateLimit: string | null; // "up/down" or null when unset
  dynamic: boolean;
  server: string | null;
  status: string | null; // bound | waiting | …
}

// ---- Diagnostics & remediation (device panel) -------------------------------

/** Result of a router→device ping. */
export interface PingResult {
  sent: number;
  received: number;
  lossPct: number;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

/** One hop of a router→device traceroute. */
export interface TraceHop {
  hop: number;
  address: string; // '' when the hop timed out
  avgMs: number | null;
  lossPct: number | null;
}

/** Network facts about a device as the router sees it (ARP + DHCP + PoE port). */
export interface DeviceNetInfo {
  arp: { macAddress: string; interface: string; dynamic: boolean } | null;
  lease: {
    hostName: string | null;
    macAddress: string;
    server: string | null;
    status: string | null;
    expiresAfter: string | null;
  } | null;
  /** Physical egress port (resolved via bridge host) — the target for PoE actions. */
  port: string | null;
  /** PoE state of `port`, present only when the port is PoE-capable. */
  poe: { name: string; status: string | null; power: string | null } | null;
}

/** A recent router log line. */
export interface RouterLogEntry {
  time: string;
  topics: string;
  message: string;
}

export interface HotspotProfile {
  '.id'?: string;
  name: string;
  'rate-limit'?: string;
  'shared-users'?: string;
  'session-timeout'?: string;
  'address-list'?: string; // set to noc-grp-<name> to make this profile an Access Profile
}

// ---- Access profiles (per-profile app policy, enforced by the noc-block engine) --

export const ACCESS_MODES = ['blocklist', 'allowlist'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const ACCESS_MEMBER_KINDS = ['subnet', 'ip', 'mac'] as const;
export type AccessMemberKind = (typeof ACCESS_MEMBER_KINDS)[number];

/** An Access Profile = a hotspot user-profile bound to address-list `noc-grp-<name>`,
 *  carrying an app policy. Composed live from router artifacts — there is no DB row.
 *  Anyone who logs in under the profile (or is tagged into the group by MAC/subnet)
 *  gets the policy, wherever on the network they are. */
export interface AccessProfile {
  name: string; // hotspot user-profile name = the profile id
  group: string; // noc-grp-<name> — the src-address-list every member lands in
  mode: AccessMode; // 'allowlist' if a NOC-ALLOW:<name> rule exists, else 'blocklist'
  services: string[]; // blocklist: the blocked service keys
  allow: string[]; // allowlist: the allowed destinations (domains/CIDRs) beyond local+DNS
  active: boolean; // blocklist: every service rule enabled; allowlist: deny-all enforced
  memberCount: number; // configured members (static subnet/ip entries + MAC-tag rules)
}

/** One configured way a device joins a profile's group. Runtime/dynamic entries
 *  (from a live hotspot login) are not listed here — only the persistent config. */
export interface AccessMember {
  id: string; // router .id: an address-list entry (.id) or a mangle rule (.id) for MAC
  kind: AccessMemberKind;
  value: string; // subnet/ip = the CIDR/IP; mac = the MAC address
  source: 'static' | 'mac'; // static = address-list entry; mac = add-src-to-address-list rule
}

export interface VoucherRow {
  username: string;
  password: string;
  profile?: string;
}

/** Per-row outcome of a bulk hotspot-user create — one bad row must not abort the batch. */
export interface BulkCreateResult {
  name: string;
  ok: boolean;
  error?: string;
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
  // Free signals from the same fleet payload (0 extra API calls): per-radio WiFi
  // channel utilization % (congestion — the "WiFi lambat" companion to wired
  // degradation) + a firmware-outdated flag and the recommended version.
  radio1Util: number | null;
  radio2Util: number | null;
  firmwareOutdated: boolean;
  recommendedFirmware: string | null;
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

/**
 * One physical LAN/uplink port of a Ruijie device (AP or switch), read live from
 * the cloud on demand. EW1300G APs expose LAN1/LAN2/LAN3-IPTV; ES208GC switches
 * expose Port 1..8. `speed` is the negotiated rate ("1000M"/"100M") when up.
 */
export interface RuijiePortDTO {
  name: string; // "LAN1", "LAN3/IPTV", "Port 2"
  port: number; // physical index (1-based)
  up: boolean; // link status
  speed: string | null; // negotiated speed when up; null when down/unknown
  medium: string | null; // "Copper" | "Fiber" (switches; APs omit it)
  enabled: boolean; // admin-enabled (switches expose it; APs default true)
}

/**
 * One port flagged by the worker's port monitor — the payoff of the whole
 * feature: a link that is UP but negotiated below its learned baseline (silent
 * slowdown), or one that is flapping. Worst-first drives the Port Health board.
 */
export interface RuijiePortHealthRow {
  routerId: string;
  routerName: string;
  groupName: string;
  siteId: string | null;
  portName: string;
  medium: string | null;
  up: boolean;
  speedMbit: number; // current negotiated speed (0 when down)
  baselineMbit: number; // learned known-good speed
  degraded: boolean; // up but slower than baseline
  degradedSince: string | null;
  flaps1h: number; // link-downs in the last hour
  lastSeenAt: string;
}

export interface RuijiePortHealth {
  summary: {
    monitoredPorts: number;
    degraded: number;
    flapping: number;
    lastPolledAt: string | null;
  };
  rows: RuijiePortHealthRow[]; // degraded first (longest-standing), then flapping
}

/** One row of a port's event timeline (degraded/recovered/link flap). */
export interface RuijiePortEventRow {
  id: string;
  portName: string;
  kind: 'degraded' | 'recovered' | 'link-down' | 'link-up';
  fromMbit: number | null;
  toMbit: number | null;
  at: string;
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
