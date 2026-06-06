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
} from './types';

/** z.enum helper that preserves literal union types from a `readonly` array. */
const zEnum = <T extends string>(vals: readonly T[]) =>
  z.enum(vals as unknown as [T, ...T[]]);

export const idParamSchema = z.object({ id: z.string().min(1) });
export const siteIdParamSchema = z.object({ siteId: z.string().min(1) });

// ---- Auth --------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email(),
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
});
export type CreateSiteInput = z.infer<typeof createSiteSchema>;

export const updateSiteSchema = createSiteSchema.partial().extend({
  // allow clearing the floorplan
  floorplanImageUrl: z.string().nullable().optional(),
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
});
export type CreateRouterInput = z.infer<typeof createRouterSchema>;

// On update password is optional: omit/empty = keep existing.
export const updateRouterSchema = createRouterSchema
  .partial()
  .omit({ siteId: true })
  .extend({ password: z.string().max(255).optional() });
export type UpdateRouterInput = z.infer<typeof updateRouterSchema>;

// ---- Device ------------------------------------------------------------------

export const createDeviceSchema = z.object({
  routerId: z.string().min(1),
  name: z.string().min(1).max(120),
  ipAddress: z.string().max(64).nullable().optional(),
  type: zEnum(DEVICE_TYPES).default('other'),
  iconKey: z.string().max(64).nullable().optional(),
  iconUrl: z.string().max(512).nullable().optional(),
  areaId: z.string().nullable().optional(),
  lineId: z.string().nullable().optional(),
  orderIndex: z.number().int().optional(),
  geoLat: z.number().min(-90).max(90).nullable().optional(),
  geoLng: z.number().min(-180).max(180).nullable().optional(),
  mapX: z.number().nullable().optional(),
  mapY: z.number().nullable().optional(),
  isCritical: z.boolean().default(false),
  note: z.string().max(2000).nullable().optional(),
  // when true the backend also creates a matching /tool/netwatch entry + scripts
  syncNetwatch: z.boolean().default(false),
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

export const updateDeviceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  ipAddress: z.string().max(64).nullable().optional(),
  type: zEnum(DEVICE_TYPES).optional(),
  iconKey: z.string().max(64).nullable().optional(),
  iconUrl: z.string().max(512).nullable().optional(),
  areaId: z.string().nullable().optional(),
  lineId: z.string().nullable().optional(),
  orderIndex: z.number().int().optional(),
  isCritical: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
  manualOverride: zEnum(MANUAL_OVERRIDES).nullable().optional(),
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
  email: z.string().email(),
  password: z.string().min(8).max(255),
  role: zEnum(ROLES).default('user'),
  scopeSiteIds: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});
export type CreateAppUserInput = z.infer<typeof createAppUserSchema>;

export const updateAppUserSchema = createAppUserSchema
  .partial()
  .extend({ password: z.string().min(8).max(255).optional() });
export type UpdateAppUserInput = z.infer<typeof updateAppUserSchema>;

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
  password: z.string().max(255).optional(),
  profile: z.string().max(120).optional(),
  server: z.string().max(120).optional(),
  limitUptime: z.string().max(64).optional(), // e.g. "1h", "30m"
  limitBytesTotal: z.string().max(64).optional(),
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
});
export type HotspotProfileUpsertInput = z.infer<typeof hotspotProfileUpsertSchema>;

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

// ---- Reports -----------------------------------------------------------------

export const uptimeReportQuerySchema = z.object({
  siteId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type UptimeReportQuery = z.infer<typeof uptimeReportQuerySchema>;
