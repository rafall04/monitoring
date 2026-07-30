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
import { maybeNotifyTelegram } from './notify';
import { publishSiteEvent, type Redis } from './redis';

export interface StatusEngineDeps {
  prisma: PrismaClient;
  redisPub: Redis;
  logger: Logger;
}

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
    where: { routerId, ipAddress: { in: updates.map((u) => u.host) } },
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
    for (const [k, v] of heartbeats) pipe.set(k, v);
    await pipe.exec();
  }

  for (const t of transitions) {
    await applyDeviceStatus(deps, t.device, t.status, source, t.at);
  }

  return { matched: byIp.size, changed: transitions.length };
}

/** Apply a status to a known device row. Returns whether the status changed. */
export async function applyDeviceStatus(
  deps: StatusEngineDeps,
  device: Device,
  newStatus: DeviceStatus,
  source: StatusSource,
  occurredAt: Date = new Date(),
): Promise<boolean> {
  const cachePayload = JSON.stringify({
    status: newStatus,
    at: occurredAt.toISOString(),
  });

  if (device.status === newStatus) {
    // No transition: just refresh the heartbeat cache so reconciliation can tell
    // the difference between "still down" and "stale".
    await deps.redisPub.set(REDIS_KEYS.deviceStatus(device.id), cachePayload);
    return false;
  }

  const oldStatus = device.status;
  // Clear ack metadata on recovery — an incident has ended; the next down event
  // is a fresh incident that must be acknowledged again.
  const clearAck = newStatus === 'up';
  const updated = await deps.prisma.$transaction(async (tx) => {
    const d = await tx.device.update({
      where: { id: device.id },
      data: {
        status: newStatus,
        statusSince: occurredAt,
        ...(clearAck ? { ackBy: null, ackAt: null } : {}),
      },
    });
    await tx.statusEvent.create({
      data: {
        deviceId: device.id,
        oldStatus,
        newStatus,
        source,
        occurredAt,
      },
    });
    return d;
  });

  await deps.redisPub.set(REDIS_KEYS.deviceStatus(device.id), cachePayload);

  await publishSiteEvent(deps.redisPub, device.siteId, {
    type: 'device.status',
    siteId: device.siteId,
    deviceId: device.id,
    status: newStatus,
    statusSince: occurredAt.toISOString(),
    source,
  });

  // Push an updated site summary so dashboards stay in sync without polling.
  const summary = await computeSiteSummary(deps.prisma, device.siteId);
  await publishSiteEvent(deps.redisPub, device.siteId, {
    type: 'site.summary',
    siteId: device.siteId,
    summary,
  });

  // Fire-and-forget Telegram alert for critical devices (server mode).
  await maybeNotifyTelegram(deps, device, oldStatus, newStatus);

  deps.logger.info(
    { deviceId: device.id, name: updated.name, oldStatus, newStatus, source },
    'device status changed',
  );
  return true;
}

/** Update a router's reachability + resource cache and broadcast it. */
export async function updateRouterStatus(
  deps: StatusEngineDeps,
  router: Pick<RouterMikrotik, 'id' | 'siteId'>,
  status: RouterStatus,
  resource: RouterResource | null,
): Promise<void> {
  const lastSeenAt = status === 'online' ? new Date() : undefined;
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
  );
  await publishSiteEvent(deps.redisPub, router.siteId, {
    type: 'router.status',
    siteId: router.siteId,
    routerId: router.id,
    status,
    lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
    resource,
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

export { toDeviceDto };
