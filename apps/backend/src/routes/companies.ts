import type { FastifyInstance } from 'fastify';
import { deleteInBatches, prisma, publishSiteSummary, toCompanyDto } from '@noc/server';
import {
  createCompanySchema,
  idParamSchema,
  REDIS_CHANNELS,
  REDIS_KEYS,
  updateCompanySchema,
  type WsServerEvent,
} from '@noc/shared';
import { notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, requirePermission } from '../plugins/rbac';

// Company management is super_admin only (gated by the 'site:manage' permission).
export async function companyRoutes(app: FastifyInstance) {
  const guard = {
    onRequest: [authenticate],
    preHandler: [requirePermission('site:manage')],
  };

  app.get('/', guard, async () => {
    const rows = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toCompanyDto);
  });

  app.post('/', guard, async (req) => {
    const body = createCompanySchema.parse(req.body);
    const c = await prisma.company.create({ data: { name: body.name } });
    await writeAudit(req, { action: 'create', entity: 'company', entityId: c.id, after: c });
    return toCompanyDto(c);
  });

  app.patch('/:id', guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateCompanySchema.parse(req.body);
    const before = await prisma.company.findUnique({ where: { id } });
    if (!before) throw notFound('Company not found');
    const c = await prisma.company.update({ where: { id }, data: body });
    await writeAudit(req, { action: 'update', entity: 'company', entityId: id, before, after: c });
    return toCompanyDto(c);
  });

  app.delete('/:id', guard, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const before = await prisma.company.findUnique({ where: { id } });
    if (!before) throw notFound('Company not found');

    // Company delete cascades sites → routers → devices → status_events: the
    // largest single-statement delete in the app. Purge the heavy leaf tables
    // across all the company's sites in ~500-row batches (same pattern as
    // site/router delete) so the final delete only sweeps the small remainder.
    const siteIds = (
      await prisma.site.findMany({ where: { companyId: id }, select: { id: true } })
    ).map((s) => s.id);
    const devices = await prisma.device.findMany({
      where: { siteId: { in: siteIds } },
      select: { id: true, siteId: true },
    });
    const routerIds = (
      await prisma.routerMikrotik.findMany({
        where: { siteId: { in: siteIds } },
        select: { id: true },
      })
    ).map((r) => r.id);
    await deleteInBatches(
      (take) =>
        prisma.statusEvent.findMany({
          where: { device: { siteId: { in: siteIds } } },
          select: { id: true },
          take,
        }),
      (ids) => prisma.statusEvent.deleteMany({ where: { id: { in: ids } } }),
    );
    await deleteInBatches(
      (take) =>
        prisma.ticket.findMany({ where: { siteId: { in: siteIds } }, select: { id: true }, take }),
      (ids) => prisma.ticket.deleteMany({ where: { id: { in: ids } } }),
    );
    await deleteInBatches(
      (take) =>
        prisma.device.findMany({ where: { siteId: { in: siteIds } }, select: { id: true }, take }),
      (ids) => prisma.device.deleteMany({ where: { id: { in: ids } } }),
    );
    await prisma.company.delete({ where: { id } });

    // Same membership fan-out as site/router delete: device.deleted per row on
    // its own site channel, then a recomputed summary per affected site.
    const pipe = app.redisPub.pipeline();
    for (const d of devices) {
      const ev: WsServerEvent = { type: 'device.deleted', siteId: d.siteId, deviceId: d.id };
      pipe.publish(REDIS_CHANNELS.siteEvents(d.siteId), JSON.stringify(ev));
      pipe.del(REDIS_KEYS.deviceStatus(d.id));
    }
    for (const routerId of routerIds) pipe.del(REDIS_KEYS.routerStatus(routerId));
    await pipe.exec();
    for (const siteId of siteIds) {
      await publishSiteSummary({ prisma, redisPub: app.redisPub }, siteId);
    }

    await writeAudit(req, { action: 'delete', entity: 'company', entityId: id, before });
    reply.code(204);
    return null;
  });
}
