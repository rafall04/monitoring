// =============================================================================
// Mass-outage awareness. When a whole site is dark (router offline) or a big
// share of its devices are down, every answer to that site's members AND
// staff should say so up-front — "we already know, it's being handled". This
// prevents 30 identical complaint tickets and stops the bot sounding ignorant
// exactly when users are most anxious.
// =============================================================================

import type { BotCtx } from './tickets';
import { ago } from './fmt';

/** down ≥ this share of the site's devices (min 3) counts as a mass outage. */
const MASS_OUTAGE_RATIO = 0.4;
const MASS_OUTAGE_MIN = 3;

export interface SiteOutage {
  /** Routers unreachable → the site is effectively dark (devices→unknown). */
  offlineRouters: { name: string; lastSeenAt: Date | null }[];
  downCount: number;
  totalDevices: number;
}

/** Null when the site is calm — callers just prepend the lines when it isn't. */
export async function siteOutage(ctx: BotCtx, siteId: string): Promise<SiteOutage | null> {
  const [offlineRouters, downCount, totalDevices] = await Promise.all([
    ctx.prisma.routerMikrotik.findMany({
      where: { siteId, status: 'offline' },
      select: { name: true, lastSeenAt: true },
    }),
    ctx.prisma.device.count({
      where: {
        siteId,
        status: 'down',
        // Maintenance devices are expected-down — not an outage signal.
        OR: [{ manualOverride: null }, { manualOverride: { not: 'maintenance' } }],
      },
    }),
    ctx.prisma.device.count({ where: { siteId } }),
  ]);
  const mass =
    downCount >= MASS_OUTAGE_MIN &&
    totalDevices > 0 &&
    downCount / totalDevices >= MASS_OUTAGE_RATIO;
  if (offlineRouters.length === 0 && !mass) return null;
  return { offlineRouters, downCount, totalDevices };
}

/**
 * Bulk variant for numbered pick-lists: which of THESE sites are dark right
 * now? One query per shape (offline routers + grouped device counts), not one
 * round-trip per site.
 */
export async function outagedSiteIds(ctx: BotCtx, siteIds: string[]): Promise<Set<string>> {
  if (siteIds.length === 0) return new Set();
  const [offlineRouters, downBySite, totalBySite] = await Promise.all([
    ctx.prisma.routerMikrotik.findMany({
      where: { siteId: { in: siteIds }, status: 'offline' },
      select: { siteId: true },
    }),
    ctx.prisma.device.groupBy({
      by: ['siteId'],
      where: {
        siteId: { in: siteIds },
        status: 'down',
        OR: [{ manualOverride: null }, { manualOverride: { not: 'maintenance' } }],
      },
      _count: { _all: true },
    }),
    ctx.prisma.device.groupBy({
      by: ['siteId'],
      where: { siteId: { in: siteIds } },
      _count: { _all: true },
    }),
  ]);
  const total = new Map(totalBySite.map((r) => [r.siteId, r._count._all]));
  const dark = new Set(offlineRouters.map((r) => r.siteId));
  for (const r of downBySite) {
    const t = total.get(r.siteId) ?? 0;
    if (t > 0 && r._count._all >= MASS_OUTAGE_MIN && r._count._all / t >= MASS_OUTAGE_RATIO) {
      dark.add(r.siteId);
    }
  }
  return dark;
}

/**
 * Card lines describing the outage. `member` tone = reassurance (no internal
 * detail); `staff` tone = operational facts (since when, how many).
 */
export function outageLines(o: SiteOutage, audience: 'member' | 'staff'): string[] {
  const lines: string[] = [];
  for (const r of o.offlineRouters) {
    lines.push(
      audience === 'member'
        ? `🔴 *Gangguan site:* koneksi ke router *${r.name}* terputus (${ago(r.lastSeenAt?.toISOString() ?? null)}) — semua layanan site terdampak.`
        : `🔴 Router *${r.name}* OFFLINE (${ago(r.lastSeenAt?.toISOString() ?? null)}) — site efektif gelap (device → unknown).`,
    );
  }
  if (o.offlineRouters.length === 0 && o.downCount > 0) {
    lines.push(
      audience === 'member'
        ? `🟠 *Gangguan massal:* *${o.downCount}* dari ${o.totalDevices} perangkat di site Anda sedang down.`
        : `🟠 Gangguan massal — *${o.downCount}/${o.totalDevices}* perangkat down.`,
    );
  }
  if (audience === 'member') {
    lines.push('_Tim NOC sudah menerima alert otomatis dan sedang menangani._');
  }
  return lines;
}
