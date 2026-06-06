// =============================================================================
// Alerts & Incidents API. Surfaces the operator workflow on top of the
// already-recorded StatusEvent + AuditLog tables.
//
//   GET    /alerts/incidents      open incidents (devices currently DOWN)
//   GET    /alerts/events         paginated status-event timeline
//   GET    /alerts/audit          paginated audit log (super_admin)
//   POST   /alerts/incidents/:deviceId/ack     mark "we are working on it"
//   POST   /alerts/incidents/:deviceId/unack   clear ack
//   POST   /alerts/incidents/:deviceId/silence suppress alerts for N minutes
// =============================================================================

import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@noc/server';
import { prisma } from '@noc/server';
import { idParamSchema, silenceSchema, type StatusEventRow, type Incident, type AuditLogRow } from '@noc/shared';
import { notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission, siteScopeWhere } from '../plugins/rbac';

export async function alertRoutes(app: FastifyInstance) {
  const view = { onRequest: [authenticate], preHandler: [requirePermission('map:view')] };
  const manage = { onRequest: [authenticate], preHandler: [requirePermission('alerts:manage')] };
  const auditView = { onRequest: [authenticate], preHandler: [requirePermission('audit:view')] };

  // ---- Open incidents: every device currently down, scoped to the user -----
  app.get('/incidents', view, async (req) => {
    const where: Prisma.DeviceWhereInput = {
      ...siteScopeWhere(req.appUser),
      status: 'down',
      // 'maintenance' is operator-marked downtime, NOT an incident to alert on.
      NOT: { manualOverride: 'maintenance' },
    };
    const q = req.query as { critical?: string };
    if (q.critical === '1') where.isCritical = true;

    const rows = await prisma.device.findMany({
      where,
      include: { site: { select: { name: true } } },
      orderBy: [{ isCritical: 'desc' }, { statusSince: 'asc' }],
      take: 500,
    });

    const now = Date.now();
    const out: Incident[] = rows.map((d) => ({
      deviceId: d.id,
      deviceName: d.name,
      siteId: d.siteId,
      siteName: d.site.name,
      isCritical: d.isCritical,
      status: d.status as Incident['status'],
      statusSince: d.statusSince ? d.statusSince.toISOString() : null,
      durationSec: d.statusSince ? Math.floor((now - d.statusSince.getTime()) / 1000) : 0,
      ackBy: d.ackBy,
      ackAt: d.ackAt ? d.ackAt.toISOString() : null,
      silencedUntil: d.silencedUntil ? d.silencedUntil.toISOString() : null,
    }));
    return out;
  });

  // ---- Status-event timeline (paginated) -----------------------------------
  app.get('/events', view, async (req) => {
    const q = req.query as {
      siteId?: string;
      deviceId?: string;
      newStatus?: string;
      critical?: string;
      limit?: string;
      cursor?: string;
    };
    const take = Math.min(200, Math.max(10, Number(q.limit) || 50));

    const scope = siteScopeWhere(req.appUser);
    const deviceWhere: Prisma.DeviceWhereInput = { ...scope };
    if (q.siteId) {
      assertSiteAccess(req.appUser, q.siteId);
      deviceWhere.siteId = q.siteId;
    }
    if (q.critical === '1') deviceWhere.isCritical = true;

    const where: Prisma.StatusEventWhereInput = { device: deviceWhere };
    if (q.deviceId) where.deviceId = q.deviceId;
    if (q.newStatus === 'down' || q.newStatus === 'up' || q.newStatus === 'unknown') {
      where.newStatus = q.newStatus;
    }
    if (q.cursor) where.id = { lt: q.cursor };

    const events = await prisma.statusEvent.findMany({
      where,
      include: { device: { include: { site: { select: { name: true } } } } },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    const hasMore = events.length > take;
    const page = events.slice(0, take);
    const rows: StatusEventRow[] = page.map((e) => ({
      id: e.id,
      deviceId: e.deviceId,
      deviceName: e.device.name,
      siteId: e.device.siteId,
      siteName: e.device.site.name,
      isCritical: e.device.isCritical,
      oldStatus: e.oldStatus as StatusEventRow['oldStatus'],
      newStatus: e.newStatus as StatusEventRow['newStatus'],
      source: e.source as StatusEventRow['source'],
      occurredAt: e.occurredAt.toISOString(),
    }));
    return { events: rows, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  });

  // ---- Audit log viewer (paginated) ----------------------------------------
  app.get('/audit', auditView, async (req) => {
    const q = req.query as { entity?: string; userId?: string; limit?: string; cursor?: string };
    const take = Math.min(200, Math.max(10, Number(q.limit) || 50));

    const where: Prisma.AuditLogWhereInput = {};
    if (q.entity) where.entity = q.entity;
    if (q.userId) where.userId = q.userId;
    if (q.cursor) where.id = { lt: q.cursor };

    const logs = await prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true } } },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    const hasMore = logs.length > take;
    const page = logs.slice(0, take);
    const rows: AuditLogRow[] = page.map((l) => ({
      id: l.id,
      userId: l.userId,
      userName: l.user?.name ?? null,
      action: l.action,
      entity: l.entity,
      entityId: l.entityId,
      ip: l.ip,
      createdAt: l.createdAt.toISOString(),
    }));
    return { logs: rows, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  });

  // ---- Acknowledge an incident --------------------------------------------
  app.post('/incidents/:id/ack', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const d = await prisma.device.findUnique({ where: { id } });
    if (!d) throw notFound('Device not found');
    assertSiteAccess(req.appUser, d.siteId);
    const u = await prisma.device.update({
      where: { id },
      data: { ackBy: req.appUser.name || req.appUser.email, ackAt: new Date() },
    });
    await writeAudit(req, {
      action: 'ack',
      entity: 'incident',
      entityId: id,
      after: { ackBy: u.ackBy, ackAt: u.ackAt },
    });
    return { ackBy: u.ackBy, ackAt: u.ackAt ? u.ackAt.toISOString() : null };
  });

  app.post('/incidents/:id/unack', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const d = await prisma.device.findUnique({ where: { id } });
    if (!d) throw notFound('Device not found');
    assertSiteAccess(req.appUser, d.siteId);
    await prisma.device.update({ where: { id }, data: { ackBy: null, ackAt: null } });
    await writeAudit(req, { action: 'unack', entity: 'incident', entityId: id });
    return { ackBy: null, ackAt: null };
  });

  // ---- Silence: suppress alerts for N minutes (0 = unsilence) -------------
  app.post('/incidents/:id/silence', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { minutes } = silenceSchema.parse(req.body);
    const d = await prisma.device.findUnique({ where: { id } });
    if (!d) throw notFound('Device not found');
    assertSiteAccess(req.appUser, d.siteId);
    const silencedUntil = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
    const u = await prisma.device.update({ where: { id }, data: { silencedUntil } });
    await writeAudit(req, {
      action: minutes > 0 ? 'silence' : 'unsilence',
      entity: 'incident',
      entityId: id,
      after: { silencedUntil: u.silencedUntil },
    });
    return { silencedUntil: u.silencedUntil ? u.silencedUntil.toISOString() : null };
  });
}
