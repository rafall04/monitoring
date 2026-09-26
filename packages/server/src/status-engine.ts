// =============================================================================
// Status engine - the single place that applies a device status change.
// Shared by the backend webhook receiver and the worker poller so behaviour is
// identical regardless of the source. Writes the change, records a StatusEvent,
// updates the Redis cache, and publishes realtime events.
// =============================================================================

import type { Prisma, PrismaClient, Device, RouterMikrotik } from '@prisma/client';
import type { Logger } from 'pino';
import {
  REDIS_KEYS,
  type DeviceStatus,
  type RouterResource,
  type RouterStatus,
  type SiteSummary,
  type StatusSource,
} from '@noc/shared';
import { toDeviceDto } from './mappers';
import { maybeNotifyTelegram, maybeNotifyWhatsApp, notifyRouterStatus } from './notify';
import { publishSiteEvent, type Redis } from './redis';

export interface StatusEngineDeps {
  prisma: PrismaClient;
  redisPub: Redis;
  logger: Logger;
}

/**
 * TTL for the `noc:device:*:status` / `noc:router:*:status` heartbeat caches.
 * Those keys are refreshed on every poll/webhook but read by no hot path —
 * without an expiry they would outlive a deleted device/router forever (the
 * delete path can't enumerate them). 1h far outlasts any poll interval or
 * circuit-breaker backoff (max 5 min), so a live device never loses its entry
 * while a deleted one self-cleans.
 */
export const STATUS_CACHE_TTL_SEC = 3600;

export interface ApplyByHostInput {
  routerId: string;
  host: string;
  status: DeviceStatus;
  source: StatusSource;
  occurredAt?: Date;
}

/** Resolve a device by router + watched host (ipAddress) and apply a status. */
export async function applyDeviceStatusByHost(
  deps: StatusEngineDeps,
  input: ApplyByHostInput,
): Promise<{ changed: boolean; device: Device | null }> {
  const device = await deps.prisma.device.findFirst({
    where: { routerId: input.routerId, ipAddress: input.host },
  });
  if (!device) {
    deps.logger.debug(
      { routerId: input.routerId, host: input.host },
      'status update for unknown device (no matching ipAddress) - ignored',
    );
    return { changed: false, device: null };
  }
  const changed = await applyDeviceStatus(
    deps,
    device,
    input.status,
    input.source,
    input.occurredAt,
  );
  return { changed, device };
}

/**
 * Batch form of applyDeviceStatusByHost for the poller, which reconciles a
 * router's ENTIRE Netwatch table on every cycle.
 *
 * The per-host function issues one findFirst and one Redis SET per entry. At
 * 197 devices that is ~10 queries/sec and unnoticeable; at the ~730 hosts this
 * fleet is heading for it becomes ~36 queries/sec sustained forever, almost all
 * of it to rediscover that nothing changed. Instead: one findMany for the whole
 * router, compare in memory, pipeline the heartbeat writes, and fall back to
 * the full single-device path only for real transitions — which is where the
 * transaction, StatusEvent, publish and Telegram alert live.
 */
export async function applyDeviceStatusesByHost(
  deps: StatusEngineDeps,
  routerId: string,
  updates: Array<{ host: string; status: DeviceStatus; occurredAt?: Date }>,
  source: StatusSource,
): Promise<{ matched: number; changed: number }> {
  if (updates.length === 0) return { matched: 0, changed: 0 };

  const devices = await deps.prisma.device.findMany({
    where: {
      routerId,
      ipAddress: { in: updates.map((u) => u.host) },
      // Probe-owned devices (interface/TCP/NAT-traffic watch) get their
      // verdict from their own probe — a Netwatch entry on the same IP must
      // not overwrite it.
      watchInterface: null,
      watchPort: null,
      watchNatDstPort: null,
    },
  });
  const byIp = new Map(devices.map((d) => [d.ipAddress as string, d]));

  const heartbeats: Array<[string, string]> = [];
  const transitions: Array<{ device: Device; status: DeviceStatus; at: Date }> = [];

  for (const u of updates) {
    const device = byIp.get(u.host);
    if (!device) continue; // netwatch entry we do not track — ignored, as before
    const at = u.occurredAt ?? new Date();
    if (device.status === u.status) {
      heartbeats.push([
        REDIS_KEYS.deviceStatus(device.id),
        JSON.stringify({ status: u.status, at: at.toISOString() }),
      ]);
    } else {
      transitions.push({ device, status: u.status, at });
    }
  }

  if (heartbeats.length > 0) {
    // One round trip instead of one per device.
    const pipe = deps.redisPub.pipeline();
    for (const [k, v] of heartbeats) pipe.set(k, v, 'EX', STATUS_CACHE_TTL_SEC);
    await pipe.exec();
  }

  const changedSites = new Set<string>();
  let changedCount = 0;
  for (const t of transitions) {
    const changed = await applyDeviceStatus(deps, t.device, t.status, source, t.at, {
      skipSiteSummary: true,
    });
    if (changed) {
      changedCount++;
      changedSites.add(t.device.siteId);
    }
  }

  // Recompute + publish site.summary ONCE per affected site at the end —
  // publishing it per device would fan out N redundant recomputes per poll.
  for (const siteId of changedSites) {
    await publishSiteSummary(deps, siteId);
  }

  return { matched: byIp.size, changed: changedCount };
}

/** Options for applyDeviceStatus. */
export interface ApplyDeviceStatusOptions {
  /**
   * Skip the site.summary recompute+publish after a transition. Batch callers
   * that apply many transitions in a loop set this and publish ONE summary per
   * affected site at the end (see applyDeviceStatusesByHost and the worker's
   * reconcile-to-unknown sweep).
   */
  skipSiteSummary?: boolean;
}

/** Apply a status to a known device row. Returns whether the status changed. */
export async function applyDeviceStatus(
  deps: StatusEngineDeps,
  device: Device,
  newStatus: DeviceStatus,
  source: StatusSource,
  occurredAt: Date = new Date(),
  opts: ApplyDeviceStatusOptions = {},
): Promise<boolean> {
  const cachePayload = JSON.stringify({
    status: newStatus,
    at: occurredAt.toISOString(),
  });

  if (device.status === newStatus) {
    // No transition: just refresh the heartbeat cache so reconciliation can tell
    // the difference between "still down" and "stale".
    await deps.redisPub.set(
      REDIS_KEYS.deviceStatus(device.id),
      cachePayload,
      'EX',
      STATUS_CACHE_TTL_SEC,
    );
    return false;
  }

  // Clear ack metadata on recovery — an incident has ended; the next down event
  // is a fresh incident that must be acknowledged again.
  const clearAck = newStatus === 'up';

  // Atomic transition. The row is re-read INSIDE the transaction and the write
  // is guarded on the status just observed (`updateMany` with `status: cur`),
  // so a concurrent writer (webhook vs poller vs reconcile) can no longer
  // interleave between our read and update — which used to produce duplicate
  // StatusEvents and clobber a fresher status. `count === 0` means another
  // writer transitioned first (or the row was deleted mid-flight): treat it as
  // "no transition" — heartbeat refresh only, no event/publish/notify.
  const applied = await deps.prisma.$transaction(async (tx) => {
    const cur = await tx.device.findUnique({ where: { id: device.id } });
    if (!cur || cur.status === newStatus) return null;
    const res = await tx.device.updateMany({
      where: { id: device.id, status: cur.status },
      data: {
        status: newStatus,
        statusSince: occurredAt,
        ...(clearAck ? { ackBy: null, ackAt: null } : {}),
      },
    });
    if (res.count === 0) return null;
    await tx.statusEvent.create({
      data: {
        deviceId: device.id,
        oldStatus: cur.status,
        newStatus,
        source,
        occurredAt,
      },
    });
    return cur;
  });

  if (!applied) {
    await deps.redisPub.set(
      REDIS_KEYS.deviceStatus(device.id),
      cachePayload,
      'EX',
      STATUS_CACHE_TTL_SEC,
    );
    return false;
  }
  const oldStatus = applied.status;

  await deps.redisPub.set(
    REDIS_KEYS.deviceStatus(device.id),
    cachePayload,
    'EX',
    STATUS_CACHE_TTL_SEC,
  );

  await publishSiteEvent(deps.redisPub, device.siteId, {
    type: 'device.status',
    siteId: device.siteId,
    deviceId: device.id,
    status: newStatus,
    statusSince: occurredAt.toISOString(),
    source,
  });

  if (!opts.skipSiteSummary) {
    // Push an updated site summary so dashboards stay in sync without polling.
    await publishSiteSummary(deps, device.siteId);
  }

  // Fire-and-forget alerts for critical devices (server modes): Telegram +
  // WhatsApp are independent channels, each gated per-site with its own
  // cooldown. `applied` is the row re-read inside the tx, so isCritical/
  // manualOverride/silencedUntil/watchInterface are as fresh as the transition.
  await maybeNotifyTelegram(deps, applied, oldStatus, newStatus);
  await maybeNotifyWhatsApp(deps, applied, oldStatus, newStatus);

  deps.logger.info(
    { deviceId: device.id, name: applied.name, oldStatus, newStatus, source },
    'device status changed',
  );
  return true;
}

/** Update a router's reachability + resource cache and broadcast it. */
export async function updateRouterStatus(
  deps: StatusEngineDeps,
  router: Pick<RouterMikrotik, 'id' | 'siteId' | 'name' | 'host'>,
  status: RouterStatus,
  resource: RouterResource | null,
): Promise<void> {
  const lastSeenAt = status === 'online' ? new Date() : undefined;
  // Read the current status first: the fan-out below is only worth it when
  // reachability actually changed — a steady 'online' heartbeat every poll
  // interval would otherwise spam every joined socket with a no-op event.
  // lastSeenAt + the Redis heartbeat are still written unconditionally.
  const prev = await deps.prisma.routerMikrotik.findUnique({
    where: { id: router.id },
    select: { status: true },
  });
  await deps.prisma.routerMikrotik.update({
    where: { id: router.id },
    data: {
      status,
      ...(lastSeenAt ? { lastSeenAt } : {}),
      ...(resource ? { resourceCache: resource as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  await deps.redisPub.set(
    REDIS_KEYS.routerStatus(router.id),
    JSON.stringify({ status, at: new Date().toISOString() }),
    'EX',
    STATUS_CACHE_TTL_SEC,
  );
  if (prev?.status === status) return;
  await publishSiteEvent(deps.redisPub, router.siteId, {
    type: 'router.status',
    siteId: router.siteId,
    routerId: router.id,
    status,
    lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
    resource,
  });
  // A real reachability flip = a site-level outage (or its recovery) — tell
  // the site's alert subscribers, not just the open dashboards.
  if (status === 'offline' || (status === 'online' && prev?.status === 'offline')) {
    await notifyRouterStatus(deps, router, status).catch(() => undefined);
  }
}

/**
 * Recompute a site's summary and publish it to the site's realtime channel —
 * the same fan-out the engine performs after a status transition. Any path
 * that changes device membership or effective status WITHOUT going through
 * applyDeviceStatus (device/router/site delete, netwatch import) must call
 * this so dashboards never hold stale up/down counts.
 */
export async function publishSiteSummary(
  deps: Pick<StatusEngineDeps, 'prisma' | 'redisPub'>,
  siteId: string,
): Promise<void> {
  const summary = await computeSiteSummary(deps.prisma, siteId);
  await publishSiteEvent(deps.redisPub, siteId, {
    type: 'site.summary',
    siteId,
    summary,
  });
}

/** Compute a site's status summary (counts + currently-down list). */
export async function computeSiteSummary(
  prisma: PrismaClient,
  siteId: string,
): Promise<SiteSummary> {
  const devices = await prisma.device.findMany({
    where: { siteId },
    select: {
      id: true,
      name: true,
      status: true,
      statusSince: true,
      manualOverride: true,
    },
  });

  let up = 0;
  let down = 0;
  let unknown = 0;
  let maintenance = 0;
  const currentlyDown: SiteSummary['currentlyDown'] = [];

  for (const d of devices) {
    if (d.manualOverride === 'maintenance') {
      maintenance++;
      continue;
    }
    if (d.status === 'up') up++;
    else if (d.status === 'down') {
      down++;
      currentlyDown.push({
        deviceId: d.id,
        name: d.name,
        since: d.statusSince ? d.statusSince.toISOString() : null,
      });
    } else unknown++;
  }

  const monitored = up + down;
  const availabilityPct =
    monitored > 0 ? Math.round((up / monitored) * 1000) / 10 : 100;

  return {
    siteId,
    total: devices.length,
    up,
    down,
    unknown,
    maintenance,
    availabilityPct,
    currentlyDown,
  };
}

/**
 * Bulk variant of computeSiteSummary — ONE device query for many sites, folded
 * in JS. Powers the overview dashboard so N sites cost 1 request, not N.
 */
export async function computeSiteSummaries(
  prisma: PrismaClient,
  siteIds: string[],
): Promise<SiteSummary[]> {
  const devices = await prisma.device.findMany({
    where: { siteId: { in: siteIds } },
    select: {
      id: true,
      siteId: true,
      name: true,
      status: true,
      statusSince: true,
      manualOverride: true,
    },
  });

  const bySite = new Map<string, typeof devices>();
  for (const d of devices) {
    const list = bySite.get(d.siteId) ?? [];
    list.push(d);
    bySite.set(d.siteId, list);
  }

  return siteIds.map((siteId) => {
    const list = bySite.get(siteId) ?? [];
    let up = 0, down = 0, unknown = 0, maintenance = 0;
    const currentlyDown: SiteSummary['currentlyDown'] = [];
    for (const d of list) {
      if (d.manualOverride === 'maintenance') {
        maintenance++;
        continue;
      }
      if (d.status === 'up') up++;
      else if (d.status === 'down') {
        down++;
        currentlyDown.push({
          deviceId: d.id,
          name: d.name,
          since: d.statusSince ? d.statusSince.toISOString() : null,
        });
      } else unknown++;
    }
    const monitored = up + down;
    return {
      siteId,
      total: list.length,
      up,
      down,
      unknown,
      maintenance,
      availabilityPct: monitored > 0 ? Math.round((up / monitored) * 1000) / 10 : 100,
      currentlyDown,
    };
  });
}

export { toDeviceDto };
