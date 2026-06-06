// =============================================================================
// Singleton Setting accessor. The migration seeds id='global' on first deploy;
// getSettings() also self-heals (idempotent upsert) so a fresh DB without the
// seed row still works.
// =============================================================================

import { prisma } from './db';
import type { Setting } from '@prisma/client';

const SETTINGS_ID = 'global';

/** Read the global settings row, creating it with defaults if missing. */
export async function getSettings(): Promise<Setting> {
  return prisma.setting.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: { id: SETTINGS_ID },
  });
}

/** Apply a partial patch to the singleton. */
export async function updateSettings(patch: Partial<Setting>): Promise<Setting> {
  // strip immutable / managed columns
  const { id: _id, updatedAt: _u, ...data } = patch;
  return prisma.setting.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    create: { id: SETTINGS_ID, ...data },
  });
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
