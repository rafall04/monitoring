// =============================================================================
// Zod validation schemas for all API inputs. Inferred types are exported for use
// in the frontend (typed forms) and backend (request validation).
// =============================================================================

import { z } from 'zod';
import {
  AREA_KINDS,
  DEVICE_TYPES,
  MANUAL_OVERRIDES,
  MAP_MODES,
  ROLES,
  ROUTEROS_VERSIONS,
  TELEGRAM_MODES,
  WHATSAPP_MODES,
} from './types';
import { TICKET_CATEGORIES } from './wa';

/** z.enum helper that preserves literal union types from a `readonly` array. */
const zEnum = <T extends string>(vals: readonly T[]) =>
  z.enum(vals as unknown as [T, ...T[]]);

export const idParamSchema = z.object({ id: z.string().min(1) });
export const siteIdParamSchema = z.object({ siteId: z.string().min(1) });

// Custom image URLs (device icons, site floorplans, org logo): local uploads
// or https only — blocks javascript:/data: URIs and plain-http tracking pixels.
const imageUrl = z
  .string()
  .max(512)
  .regex(/^(\/uploads\/|https:\/\/)/, 'Only /uploads/ or https:// URLs');

// ---- Auth --------------------------------------------------------------------

// Login identifier: an email OR a plain username (no spaces). The DB column is
// still `email` (unique), but operators can use short usernames like "aldi".
export const loginId = z
  .string()
  .trim()
  .min(3, 'Min. 3 karakter')
  .max(255)
  .regex(/^\S+$/, 'Tanpa spasi');

export const loginSchema = z.object({
  email: loginId,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

// ---- Company -----------------------------------------------------------------

export const createCompanySchema = z.object({
  name: z.string().min(1).max(120),
});
export const updateCompanySchema = createCompanySchema.partial();
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

// ---- Site --------------------------------------------------------------------

const imageBoundsSchema = z
  .tuple([
    z.tuple([z.number(), z.number()]),
    z.tuple([z.number(), z.number()]),
  ])
  .nullable();

export const createSiteSchema = z.object({
  companyId: z.string().min(1),
  name: z.string().min(1).max(120),
  region: z.string().max(120).nullable().optional(),
  mapMode: zEnum(MAP_MODES).default('geo'),
  geoCenterLat: z.number().min(-90).max(90).nullable().optional(),
  geoCenterLng: z.number().min(-180).max(180).nullable().optional(),
  defaultZoom: z.number().int().min(0).max(22).default(13),
  // floorplan image is set via the upload endpoint; bounds/dims may be sent here
  // once the image dimensions are known on the client.
  imageBounds: imageBoundsSchema.optional(),
  floorplanWidth: z.number().int().positive().nullable().optional(),
  floorplanHeight: z.number().int().positive().nullable().optional(),
  telegramMode: zEnum(TELEGRAM_MODES).optional(),
  telegramChatId: z.string().max(64).nullable().optional(),
  telegramBotToken: z.string().max(255).optional(), // plaintext in; stored encrypted
  whatsappMode: zEnum(WHATSAPP_MODES).optional(),
});
export type CreateSiteInput = z.infer<typeof createSiteSchema>;

export const updateSiteSchema = createSiteSchema.partial().extend({
  // allow clearing the floorplan (null); same /uploads/-or-https restriction
  // as iconUrl — it lands in an <img>/ImageOverlay src, so http:// tracking
  // pixels and javascript:/data: URIs are rejected.
  floorplanImageUrl: imageUrl.nullable().optional(),
});
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;

// ---- Area & Line (factory zones / production lines) --------------------------

export const createAreaSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: zEnum(AREA_KINDS).default('lines'),
});
export type CreateAreaInput = z.infer<typeof createAreaSchema>;

export const updateAreaSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: zEnum(AREA_KINDS).optional(),
});
export type UpdateAreaInput = z.infer<typeof updateAreaSchema>;

export const createLineSchema = z.object({
  areaId: z.string().min(1),
  name: z.string().min(1).max(120),
});
export type CreateLineInput = z.infer<typeof createLineSchema>;

export const updateLineSchema = z.object({ name: z.string().min(1).max(120) });
export type UpdateLineInput = z.infer<typeof updateLineSchema>;

/** Reorder siblings (areas, lines, or devices) by passing ids in the new order. */
export const reorderSchema = z.object({ ids: z.array(z.string().min(1)).max(500) });
export type ReorderInput = z.infer<typeof reorderSchema>;

/** Assign a device to an area/line (null clears the assignment). */
export const assignDeviceSchema = z.object({
  areaId: z.string().nullable().optional(),
  lineId: z.string().nullable().optional(),
});
export type AssignDeviceInput = z.infer<typeof assignDeviceSchema>;

// ---- Router (MikroTik) -------------------------------------------------------

export const createRouterSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  apiPort: z.number().int().min(1).max(65535).default(8728),
  useTls: z.boolean().default(false),
  username: z.string().min(1).max(120),
  password: z.string().min(0).max(255),
  routerosVersion: zEnum(ROUTEROS_VERSIONS).default('v6'),
  pollIntervalSec: z.number().int().min(5).max(3600).nullable().optional(),
  // Firewall drift watch (nat/filter/mangle snapshot+diff → alert+audit).
  watchConfig: z.boolean().default(true),
});
export type CreateRouterInput = z.infer<typeof createRouterSchema>;

// On update password is optional: omit/empty = keep existing.
export const updateRouterSchema = createRouterSchema
  .partial()
  .omit({ siteId: true })
  .extend({ password: z.string().max(255).optional() });
export type UpdateRouterInput = z.infer<typeof updateRouterSchema>;

// ---- Device ------------------------------------------------------------------

// ipAddress may be an IP literal OR a hostname — but it is interpolated
// straight into RouterOS /tool/netwatch commands (host=<v>, find where
// host="<v>"), so whitespace, quotes, backslashes and control chars are
// rejected outright.
const deviceIp = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s"'\\\x00-\x1f\x7f]+$/, 'IP/hostname contains invalid characters');

// The device name lands in the Netwatch entry's comment field — single line.
const deviceName = z.string().min(1).max(120).regex(/^[^\r\n]+$/, 'Name must be a single line');

/**
 * Alert window ("jam kerja") for interface-watch devices — see AlertWindow in
 * types.ts. Minutes after midnight; ISO weekday numbers 1=Mon..7=Sun; start=end
 * is rejected as meaningless (use null to disable instead).
 */
export const alertWindowSchema = z
  .object({
    startMin: z.number().int().min(0).max(1439),
    endMin: z.number().int().min(0).max(1439),
    days: z.array(z.number().int().min(1).max(7)).min(1),
  })
  .refine((w) => w.startMin !== w.endMin, {
    message: 'Jam mulai dan selesai tidak boleh sama',
  });
export type AlertWindowInput = z.infer<typeof alertWindowSchema>;

export const createDeviceSchema = z.object({
  routerId: z.string().min(1),
  name: deviceName,
  ipAddress: deviceIp.nullable().optional(),
  type: zEnum(DEVICE_TYPES).default('other'),
  iconKey: z.string().max(64).nullable().optional(),
  iconUrl: imageUrl.nullable().optional(),
  areaId: z.string().nullable().optional(),
  lineId: z.string().nullable().optional(),
  orderIndex: z.number().int().optional(),
  geoLat: z.number().min(-90).max(90).nullable().optional(),
  geoLng: z.number().min(-180).max(180).nullable().optional(),
  mapX: z.number().nullable().optional(),
  mapY: z.number().nullable().optional(),
  isCritical: z.boolean().default(false),
  note: z.string().max(2000).nullable().optional(),
  // Interface watch ("uplink"): status follows the named interface's running
  // flag instead of Netwatch. Optional per-device alert-window override.
  watchInterface: z.string().max(64).nullable().optional(),
  // TCP port watch: status = TCP connect from the NOC server to
  // ipAddress:watchPort — detects "host up, service dead" that ping can't.
  watchPort: z.number().int().min(1).max(65535).nullable().optional(),
  // NAT traffic watch: byte-counter of the dstnat rule with this dst-port;
  // stale minutes before 'down' (default 5).
  watchNatDstPort: z.string().max(16).nullable().optional(),
  watchNatStaleMin: z.number().int().min(1).max(1440).nullable().optional(),
  watchAlertWindow: alertWindowSchema.nullable().optional(),
  // Auto-create the matching /tool/netwatch entry on the router after save.
  // Defaults to TRUE — operators only enter name + IP; Netwatch is wired up
  // automatically using the global Settings (interval/timeout/extra script).
  // Skipped when ipAddress is null.
  syncNetwatch: z.boolean().default(true),
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

export const updateDeviceSchema = z.object({
  name: deviceName.optional(),
  ipAddress: deviceIp.nullable().optional(),
  type: zEnum(DEVICE_TYPES).optional(),
  iconKey: z.string().max(64).nullable().optional(),
  iconUrl: imageUrl.nullable().optional(),
  areaId: z.string().nullable().optional(),
  lineId: z.string().nullable().optional(),
  orderIndex: z.number().int().optional(),
  isCritical: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
  manualOverride: zEnum(MANUAL_OVERRIDES).nullable().optional(),
  // Interface watch — null clears the watch (device becomes plain Netwatch).
  watchInterface: z.string().max(64).nullable().optional(),
  // TCP port watch — null clears it. Mutually exclusive with watchInterface.
  watchPort: z.number().int().min(1).max(65535).nullable().optional(),
  // NAT traffic watch — dst-port matched in dstnat rules.
  watchNatDstPort: z.string().max(16).nullable().optional(),
  watchNatStaleMin: z.number().int().min(1).max(1440).nullable().optional(),
  watchAlertWindow: alertWindowSchema.nullable().optional(),
  // when true the backend (re)installs the matching /tool/netwatch entry on the
  // router — e.g. after the IP address changed. Not a stored column.
  syncNetwatch: z.boolean().optional(),
});
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;

/** Position patch: geo (lat/lng) for geo maps, or x/y for floorplan maps. */
export const patchDevicePositionSchema = z
  .object({
    geoLat: z.number().min(-90).max(90).nullable().optional(),
    geoLng: z.number().min(-180).max(180).nullable().optional(),
    mapX: z.number().nullable().optional(),
    mapY: z.number().nullable().optional(),
  })
  .refine(
    (v) =>
      (v.geoLat != null && v.geoLng != null) ||
      (v.mapX != null && v.mapY != null),
    { message: 'Provide geoLat+geoLng (geo) or mapX+mapY (floorplan)' },
  );
export type PatchDevicePositionInput = z.infer<typeof patchDevicePositionSchema>;

// ---- App user ----------------------------------------------------------------

export const createAppUserSchema = z.object({
  name: z.string().min(1).max(120),
  email: loginId,
  password: z.string().min(8).max(255),
  role: zEnum(ROLES).default('viewer'),
  scopeSiteIds: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  // WhatsApp number for bot commands. Admin-set is trusted → counts as verified.
  phone: z.string().max(20).nullable().optional(),
  // Org unit shown on complaint tickets. Free text.
  department: z.string().max(120).nullable().optional(),
});
export type CreateAppUserInput = z.infer<typeof createAppUserSchema>;

export const updateAppUserSchema = createAppUserSchema
  .partial()
  .extend({ password: z.string().min(8).max(255).optional() });
export type UpdateAppUserInput = z.infer<typeof updateAppUserSchema>;

// Self-service profile edit — name + department (email changes go through the
// admin path so they cannot be used to lock the account out).
export const updateProfileSchema = z.object({
  name: z.string().min(1).max(120),
  department: z.string().max(120).nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

// Member's own complaint (web twin of the bot's KOMPLAIN command). Site and
// reporter identity come from the member account — never the request body.
export const memberTicketSchema = z.object({
  message: z.string().min(5).max(1000),
  category: zEnum(TICKET_CATEGORIES).default('gangguan'),
  // Falls back to the profile's department when omitted.
  department: z.string().max(120).nullable().optional(),
});
export type MemberTicketInput = z.infer<typeof memberTicketSchema>;

// ---- Firewall / access control ----------------------------------------------

export const toggleBlockSchema = z.object({ active: z.boolean() });
export type ToggleBlockInput = z.infer<typeof toggleBlockSchema>;

// address: an IP, CIDR, or range. Kept permissive but bounded; RouterOS validates.
export const addAddressListSchema = z.object({
  list: z.string().min(1).max(64),
  address: z.string().min(1).max(64),
  comment: z.string().max(120).optional(),
});
export type AddAddressListInput = z.infer<typeof addAddressListSchema>;

// ---- Bandwidth / QoS --------------------------------------------------------

// maxLimit is RouterOS "up/down" rate syntax, e.g. "2M/2M", "512k/1M", "0/0".
const rateLimit = z.string().max(32).regex(/^[0-9kmgKMG/]*$/, 'Format: 2M/2M');

export const addSimpleQueueSchema = z.object({
  name: z.string().min(1).max(64),
  target: z.string().min(1).max(64), // IP or subnet
  maxLimit: rateLimit.min(1),
});
export type AddSimpleQueueInput = z.infer<typeof addSimpleQueueSchema>;

export const updateSimpleQueueSchema = z.object({ maxLimit: rateLimit.min(1) });
export type UpdateSimpleQueueInput = z.infer<typeof updateSimpleQueueSchema>;

// empty string clears the lease rate-limit
export const setLeaseRateSchema = z.object({ rateLimit });
export type SetLeaseRateInput = z.infer<typeof setLeaseRateSchema>;

// ---- Diagnostics & remediation ----------------------------------------------
// IPv4/IPv6 literal only (never a hostname) — this value is passed straight to a
// RouterOS command, so keep the charset tight.
const ipLiteral = z.string().min(3).max(45).regex(/^[0-9a-fA-F:.]+$/, 'IP tidak valid');

export const diagIpSchema = z.object({ ip: ipLiteral });
export type DiagIpInput = z.infer<typeof diagIpSchema>;

export const pingQuerySchema = z.object({
  ip: ipLiteral,
  count: z.coerce.number().int().min(1).max(10).optional(),
});
export type PingQueryInput = z.infer<typeof pingQuerySchema>;

// Interface name (RouterOS): letters/digits and - _ . / and space (e.g. "ether5").
export const poeCycleSchema = z.object({
  port: z.string().min(1).max(64).regex(/^[A-Za-z0-9 ._/\-]+$/, 'Nama port tidak valid'),
});
export type PoeCycleInput = z.infer<typeof poeCycleSchema>;

// ---- Managed block intents --------------------------------------------------
const nocName = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Huruf/angka/._- saja');
export const createIntentSchema = z.object({
  service: nocName, // service key, or 'internet'
  group: nocName.default('semua'), // 'semua' or a group name
});
export type CreateIntentInput = z.infer<typeof createIntentSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(255),
  newPassword: z.string().min(8).max(255),
  // Post the session's current refresh token to keep it alive through the
  // revoke-all; without it every session (including this one) is logged out.
  refreshToken: z.string().min(10).optional(),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---- Webhook (Netwatch -> backend) -------------------------------------------

export const netwatchWebhookSchema = z.object({
  host: z.string().min(1),
  status: z.enum(['up', 'down']),
  // routerId is embedded by the generated script; token comes via header.
  routerId: z.string().optional(),
  comment: z.string().optional(),
  since: z.string().optional(),
});
export type NetwatchWebhookInput = z.infer<typeof netwatchWebhookSchema>;

// ---- Hotspot (lighter module; data lives on MikroTik) ------------------------

export const hotspotUserCreateSchema = z.object({
  name: z.string().min(1).max(120),
  // Explicit password, min 6: every created user is provisioned a member login
  // with this same credential, so a blank/absent password is no longer allowed
  // (provisioning used to silently fall back to password=username).
  password: z.string().min(6, 'Min. 6 karakter').max(255),
  profile: z.string().max(120).optional(),
  server: z.string().max(120).optional(),
  limitUptime: z.string().max(64).optional(), // e.g. "1h", "30m"
  limitBytesTotal: z.string().max(64).optional(),
  // Device limit (simultaneous logins). RouterOS only has shared-users on the
  // user-profile, so the backend realises this via a `<profile>-<n>D` variant.
  sharedUsers: z.string().max(16).optional(), // e.g. "2"
  comment: z.string().max(255).optional(),
});
export type HotspotUserCreateInput = z.infer<typeof hotspotUserCreateSchema>;

export const hotspotUserUpdateSchema = hotspotUserCreateSchema
  .partial()
  .extend({ id: z.string().min(1) });
export type HotspotUserUpdateInput = z.infer<typeof hotspotUserUpdateSchema>;

// Profile create/edit. `id` present => update an existing profile, else create.
export const hotspotProfileUpsertSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  rateLimit: z.string().max(64).optional(), // e.g. "2M/2M"
  sharedUsers: z.string().max(16).optional(), // e.g. "1"
  sessionTimeout: z.string().max(64).optional(), // e.g. "1h"
  addressList: z.string().max(64).optional(), // '' clears; noc-grp-<name> = Access Profile
});
export type HotspotProfileUpsertInput = z.infer<typeof hotspotProfileUpsertSchema>;

// ---- Access profiles --------------------------------------------------------
// The profile name flows into RouterOS list names (noc-grp-<name>, noc-allow-<name>)
// and rule comments, so it is bounded to nocName and kept short so the prefixed
// list name stays under RouterOS's length limit.
export const accessProfileCreateSchema = z.object({
  name: nocName.max(48),
  mode: z.enum(['blocklist', 'allowlist']).default('blocklist'),
});
export type AccessProfileCreateInput = z.infer<typeof accessProfileCreateSchema>;

export const accessPolicySchema = z.object({
  mode: z.enum(['blocklist', 'allowlist']),
  services: z.array(nocName).max(64).default([]), // blocklist: blocked service keys
  allow: z.array(z.string().min(1).max(80)).max(128).default([]), // allowlist: allowed domains/CIDR/IP
  enforce: z.boolean().optional(), // allowlist only: activate the deny-all drop (default off = staged)
});
export type AccessPolicyInput = z.infer<typeof accessPolicySchema>;

export const accessMemberSchema = z.object({
  kind: z.enum(['subnet', 'ip', 'mac']),
  value: z.string().min(1).max(64),
});
export type AccessMemberInput = z.infer<typeof accessMemberSchema>;

export const voucherGenSchema = z.object({
  count: z.number().int().min(1).max(1000),
  profile: z.string().max(120).optional(),
  server: z.string().max(120).optional(),
  prefix: z.string().max(32).default(''),
  usernameLength: z.number().int().min(3).max(24).default(6),
  passwordLength: z.number().int().min(3).max(24).default(6),
  charset: z.string().min(2).max(80).default('abcdefghijkmnpqrstuvwxyz23456789'),
  sameAsUsername: z.boolean().default(false),
  limitUptime: z.string().max(64).optional(),
  limitBytesTotal: z.string().max(64).optional(),
  comment: z.string().max(255).optional(),
});
export type VoucherGenInput = z.infer<typeof voucherGenSchema>;

export const hotspotDisconnectSchema = z.object({ id: z.string().min(1) });
export type HotspotDisconnectInput = z.infer<typeof hotspotDisconnectSchema>;

// Bulk user add (e.g. RSVP import): each row is a normal user-create payload —
// explicit password included. Per-row router errors come back in the result
// instead of aborting the batch (schema-invalid input still rejects upfront).
export const hotspotUserBulkSchema = z.object({
  users: z.array(hotspotUserCreateSchema).min(1).max(500),
});
export type HotspotUserBulkInput = z.infer<typeof hotspotUserBulkSchema>;

// ---- Member self-service (/me/hotspot) ---------------------------------------
// Hotspot creds stay simpler than staff passwords (min 8), but still bounded at
// min 6 — the member owns the credential. Rate-limit the endpoint like login.
export const hotspotSelfPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(255),
  newPassword: z.string().min(6, 'Min. 6 karakter').max(255),
});
export type HotspotSelfPasswordInput = z.infer<typeof hotspotSelfPasswordSchema>;

// Kick own sessions: `id` disconnects one session, omitted kicks all of them.
export const hotspotKickSchema = z.object({ id: z.string().min(1).optional() });
export type HotspotKickInput = z.infer<typeof hotspotKickSchema>;

// ---- Settings / Branding -----------------------------------------------------

// "R G B" channel triplet, each 0..255, e.g. "59 130 246"
const accentRgbRegex = /^\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s*$/;

export const updateSettingsSchema = z.object({
  orgName: z.string().min(1).max(80).optional(),
  logoUrl: imageUrl.nullable().optional(),
  accentRgb: z.string().regex(accentRgbRegex, 'Use "R G B" channel triplet').optional(),
  themeDefault: z.enum(['dark', 'light']).optional(),
  defaultMapLat: z.number().min(-90).max(90).optional(),
  defaultMapLng: z.number().min(-180).max(180).optional(),
  defaultMapZoom: z.number().int().min(0).max(22).optional(),
  defaultPollSec: z.number().int().min(5).max(3600).optional(),
  eventRetentionDays: z.number().int().min(7).max(3650).optional(),
  auditRetentionDays: z.number().int().min(7).max(3650).optional(),
  // Netwatch tuning + custom RouterOS script tail
  netwatchIntervalSec: z.number().int().min(2).max(3600).optional(),
  netwatchTimeoutMs: z.number().int().min(100).max(60_000).optional(),
  netwatchExtraUp: z.string().max(4000).nullable().optional(),
  netwatchExtraDown: z.string().max(4000).nullable().optional(),
  // Telegram templates (free text with {device} {ip} {site} {status} {when})
  telegramDownTemplate: z.string().min(1).max(1000).optional(),
  telegramUpTemplate: z.string().min(1).max(1000).optional(),
  // WhatsApp bot templates + complaint intake
  waDownTemplate: z.string().min(1).max(2000).optional(),
  waUpTemplate: z.string().min(1).max(2000).optional(),
  waBotName: z.string().min(1).max(80).optional(),
  waComplaintEnabled: z.boolean().optional(),
  waTicketEscalateMin: z.number().int().min(5).max(24 * 60).optional(),
  // Global alert window for interface-watch devices (per-device override lives
  // on Device.watchAlertWindow). Minutes after midnight; ISO weekdays 1-7.
  uplinkAlertStartMin: z.number().int().min(0).max(1439).optional(),
  uplinkAlertEndMin: z.number().int().min(0).max(1439).optional(),
  uplinkAlertDays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// ---- Alerts / Incidents ------------------------------------------------------

export const silenceSchema = z.object({
  /** Minutes from now. 0 = un-silence. Max 1 week. */
  minutes: z.number().int().min(0).max(7 * 24 * 60),
});
export type SilenceInput = z.infer<typeof silenceSchema>;

// ---- Reports -----------------------------------------------------------------

export const uptimeReportQuerySchema = z.object({
  siteId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type UptimeReportQuery = z.infer<typeof uptimeReportQuerySchema>;

// ---- Ruijie / Reyee Cloud ----------------------------------------------------

export const createRuijieAccountSchema = z.object({
  label: z.string().min(1).max(120).default('Ruijie Cloud'),
  appId: z.string().min(1).max(255),
  appSecret: z.string().min(1).max(512), // plaintext in; stored encrypted
  baseUrl: z.string().url().max(255).default('https://cloud-as.ruijienetworks.com'),
  // min 30s: per-account daily quota is 5,000 — polling faster than ~30s risks it.
  pollIntervalSec: z.number().int().min(30).max(3600).nullable().optional(),
});
export type CreateRuijieAccountInput = z.infer<typeof createRuijieAccountSchema>;

// On update appSecret is optional: omit/empty = keep existing.
export const updateRuijieAccountSchema = createRuijieAccountSchema
  .partial()
  .extend({ appSecret: z.string().max(512).optional() });
export type UpdateRuijieAccountInput = z.infer<typeof updateRuijieAccountSchema>;

// The monitor allowlist: which Ruijie project/group ids the NOC tracks. The
// worker only stores devices in these groups (so the personal account's non-NOC
// sites never reach our DB or the UI). Empty array = monitor nothing.
export const ruijieMonitoredGroupsSchema = z.object({
  monitoredGroupIds: z.array(z.string().min(1).max(64)).max(500),
});
export type RuijieMonitoredGroupsInput = z.infer<typeof ruijieMonitoredGroupsSchema>;

// Map each Ruijie project (keyed by groupName) to a NOC site, so the Site page
// can surface that project's AP + connected-client counts. Unassigned projects
// are simply omitted from the map.
export const ruijieSiteMapSchema = z.object({
  groupSiteMap: z.record(z.string().min(1).max(200), z.string().min(1).max(64)),
});
export type RuijieSiteMapInput = z.infer<typeof ruijieSiteMapSchema>;

// ---- Audit log query ---------------------------------------------------------

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().min(1).max(64).optional(),
  entity: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
