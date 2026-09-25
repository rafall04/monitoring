import type { FastifyInstance } from 'fastify';
import { prisma, type Prisma } from '@noc/server';
import { uptimeReportQuerySchema } from '@noc/shared';
import {
  assertSiteAccess,
  authenticate,
  requirePermission,
  siteScopeWhere,
} from '../plugins/rbac';

interface DeviceUptime {
  deviceId: string;
  name: string;
  siteId: string;
  isCritical: boolean;
  currentStatus: string;
  outages: number;
  downtimeSeconds: number;
  availabilityPct: number;
}

export async function reportRoutes(app: FastifyInstance) {
  const guard = { onRequest: [authenticate], preHandler: [requirePermission('reports:view')] };

  // Basic uptime/SLA report computed from status_event transitions in a window.
  app.get('/uptime', guard, async (req) => {
    const q = uptimeReportQuerySchema.parse(req.query);
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400000);
    const rangeSec = Math.max(1, (to.getTime() - from.getTime()) / 1000);

    const where: Prisma.DeviceWhereInput = siteScopeWhere(req.appUser);
    if (q.siteId) {
      assertSiteAccess(req.appUser, q.siteId);
      where.siteId = q.siteId;
    }

    const devices = await prisma.device.findMany({
      where,
      select: { id: true, name: true, siteId: true, status: true, isCritical: true },
    });
    const ids = devices.map((d) => d.id);
    // Safety valve: a pathological fleet could exceed this many transitions in
    // the window; cap rather than stream the whole table into memory.
    const events = await prisma.statusEvent.findMany({
      where: { deviceId: { in: ids }, occurredAt: { gte: from, lte: to } },
      orderBy: { occurredAt: 'asc' },
      select: { deviceId: true, newStatus: true, occurredAt: true },
      take: 50_000,
    });

    // State AT the window start: downtime that began before `from` used to be
    // invisible (the opening "down" event sits outside the window). Seed each
    // device from its last event before `from`; fall back to the current
    // status when a device has no history at all.
    const priorEvents = await prisma.statusEvent.findMany({
      where: { deviceId: { in: ids }, occurredAt: { lt: from } },
      orderBy: { occurredAt: 'desc' },
      distinct: ['deviceId'],
      select: { deviceId: true, newStatus: true },
    });
    const statusAtFrom = new Map<string, string>(priorEvents.map((e) => [e.deviceId, e.newStatus]));
    for (const d of devices) {
      if (!statusAtFrom.has(d.id)) statusAtFrom.set(d.id, d.status);
    }

    const byDevice = new Map<string, typeof events>();
    for (const e of events) {
      const arr = byDevice.get(e.deviceId) ?? [];
      arr.push(e);
      byDevice.set(e.deviceId, arr);
    }

    const report: DeviceUptime[] = devices.map((d) => {
      const evs = byDevice.get(d.id) ?? [];
      let outages = 0;
      let downtime = 0;
      // Already down at `from` => accrue from the window start, not the first
      // in-window event. The ongoing outage isn't counted as a new outage.
      let downStart: Date | null = statusAtFrom.get(d.id) === 'down' ? from : null;
      for (const e of evs) {
        if (e.newStatus === 'down') {
          outages++;
          if (!downStart) downStart = e.occurredAt;
        } else if (e.newStatus === 'up' && downStart) {
          downtime += (e.occurredAt.getTime() - downStart.getTime()) / 1000;
          downStart = null;
        }
      }
      // still down at end of window
      if (downStart) downtime += (to.getTime() - downStart.getTime()) / 1000;
      const availabilityPct =
        Math.round((1 - Math.min(downtime, rangeSec) / rangeSec) * 1000) / 10;
      return {
        deviceId: d.id,
        name: d.name,
        siteId: d.siteId,
        isCritical: d.isCritical,
        currentStatus: d.status,
        outages,
        downtimeSeconds: Math.round(downtime),
        availabilityPct,
      };
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      devices: report.sort((a, b) => a.availabilityPct - b.availabilityPct),
    };
  });
}
