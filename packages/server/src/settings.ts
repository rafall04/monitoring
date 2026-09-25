// =============================================================================
// Singleton Setting accessor. The migration seeds id='global' on first deploy;
// getSettings() also self-heals (idempotent upsert) so a fresh DB without the
// seed row still works.
// =============================================================================

import { prisma } from './db';
import type { Setting } from '@prisma/client';
import type { NetwatchConfig } from './mikrotik/netwatch';

const SETTINGS_ID = 'global';

/**
 * The singleton is read on every worker poll, every device status transition
 * (notify gates/templates) and every branding request — but it changes maybe
 * once a week. A short in-process cache turns that hot read into memory;
 * backend and worker each hold their own copy, so a cross-process update can
 * lag by at most this TTL.
 */
const SETTINGS_CACHE_TTL_MS = 5_000;
let cached: { row: Setting; at: number } | null = null;
let inflight: Promise<Setting> | null = null;

/** Read the global settings row, creating it with defaults if missing. */
export async function getSettings(): Promise<Setting> {
  const now = Date.now();
  if (cached && now - cached.at < SETTINGS_CACHE_TTL_MS) return cached.row;
  if (!inflight) {
    // A shared in-flight promise collapses concurrent misses into one DB hit
    // (e.g. a poll tick + two alerts firing in the same millisecond).
    inflight = (async () => {
      // Plain findUnique first: the old unconditional upsert performed a
      // WRITE on every read — Postgres bumps @updatedAt even on
      // `update: {}` — i.e. a write-per-read on the hottest accessor in the
      // app. The upsert now only runs when the row is genuinely missing
      // (fresh DB before seed), where it also absorbs a create race.
      const row =
        (await prisma.setting.findUnique({ where: { id: SETTINGS_ID } })) ??
        (await prisma.setting.upsert({
          where: { id: SETTINGS_ID },
          update: {},
          create: { id: SETTINGS_ID },
        }));
      cached = { row, at: Date.now() };
      return row;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Apply a partial patch to the singleton. */
export async function updateSettings(patch: Partial<Setting>): Promise<Setting> {
  // strip immutable / managed columns
  const { id: _id, updatedAt: _u, ...data } = patch;
  const row = await prisma.setting.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data },
  });
  // Invalidate-by-replace: serve the row we just wrote so this process sees
  // the change immediately instead of after the TTL.
  cached = { row, at: Date.now() };
  return row;
}

/** Public branding shape — readable WITHOUT auth (login page needs it). */
export interface BrandingPublic {
  orgName: string;
  logoUrl: string | null;
  accentRgb: string;
  themeDefault: 'dark' | 'light';
}

export function toBrandingPublic(s: Setting): BrandingPublic {
  return {
    orgName: s.orgName,
    logoUrl: s.logoUrl,
    accentRgb: s.accentRgb,
    themeDefault: (s.themeDefault === 'light' ? 'light' : 'dark'),
  };
}

/** Subset consumed by the Netwatch script generator + Telegram notifier. */
export function toNetwatchConfig(s: Setting): NetwatchConfig {
  return {
    intervalSec: s.netwatchIntervalSec,
    timeoutMs: s.netwatchTimeoutMs,
    extraUp: s.netwatchExtraUp,
    extraDown: s.netwatchExtraDown,
    telegramDownTemplate: s.telegramDownTemplate,
    telegramUpTemplate: s.telegramUpTemplate,
  };
}

/** Convenience: read Setting + map to NetwatchConfig in one call. */
export async function getNetwatchConfig(): Promise<NetwatchConfig> {
  return toNetwatchConfig(await getSettings());
}
