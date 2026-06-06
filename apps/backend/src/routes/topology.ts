import type { FastifyInstance } from 'fastify';
import { prisma, toAreaDto, toLineDto } from '@noc/server';
import {
  createAreaSchema,
  createLineSchema,
  idParamSchema,
  reorderSchema,
  updateAreaSchema,
  updateLineSchema,
} from '@noc/shared';
import { notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission } from '../plugins/rbac';

/**
 * Factory structure: Areas (zones) and Lines (ordered production lines inside a
 * "lines" area). Creating/renaming/reordering structure is super_admin-level
 * (site:manage); operators populate it by assigning devices (see devices route).
 */
export async function topologyRoutes(app: FastifyInstance) {
  const manage = { onRequest: [authenticate], preHandler: [requirePermission('site:manage')] };

  // ---- Areas -----------------------------------------------------------------
  app.post('/areas', manage, async (req) => {
    const body = createAreaSchema.parse(req.body);
    assertSiteAccess(req.appUser, body.siteId);
    const orderIndex = await prisma.area.count({ where: { siteId: body.siteId } });
    const area = await prisma.area.create({
      data: { siteId: body.siteId, name: body.name, kind: body.kind, orderIndex },
    });
    await writeAudit(req, { action: 'create', entity: 'area', entityId: area.id, after: { name: area.name, kind: area.kind } });
    return toAreaDto({ ...area, lines: [] });
  });

  app.patch('/areas/:id', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateAreaSchema.parse(req.body);
    const before = await prisma.area.findUnique({ where: { id } });
    if (!before) throw notFound('Area not found');
    assertSiteAccess(req.appUser, before.siteId);
    const area = await prisma.area.update({
      where: { id },
      data: body,
      include: { lines: { orderBy: { orderIndex: 'asc' } } },
    });
    await writeAudit(req, { action: 'update', entity: 'area', entityId: id, before: { name: before.name }, after: { name: area.name, kind: area.kind } });
    return toAreaDto(area);
  });

  app.delete('/areas/:id', manage, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const before = await prisma.area.findUnique({ where: { id } });
    if (!before) throw notFound('Area not found');
    assertSiteAccess(req.appUser, before.siteId);
    await prisma.area.delete({ where: { id } }); // devices unassigned via FK SetNull
    await writeAudit(req, { action: 'delete', entity: 'area', entityId: id, before: { name: before.name } });
    reply.code(204);
    return null;
  });

  app.post('/areas/reorder', manage, async (req) => {
    const { ids } = reorderSchema.parse(req.body);
    const areas = await prisma.area.findMany({ where: { id: { in: ids } }, select: { siteId: true } });
    for (const a of areas) assertSiteAccess(req.appUser, a.siteId);
    await prisma.$transaction(ids.map((id, i) => prisma.area.update({ where: { id }, data: { orderIndex: i } })));
    return { ok: true };
  });

  // ---- Lines -----------------------------------------------------------------
  app.post('/lines', manage, async (req) => {
    const body = createLineSchema.parse(req.body);
    const area = await prisma.area.findUnique({ where: { id: body.areaId } });
    if (!area) throw notFound('Area not found');
    assertSiteAccess(req.appUser, area.siteId);
    const orderIndex = await prisma.line.count({ where: { areaId: body.areaId } });
    const line = await prisma.line.create({ data: { areaId: body.areaId, name: body.name, orderIndex } });
    await writeAudit(req, { action: 'create', entity: 'line', entityId: line.id, after: { name: line.name } });
    return toLineDto(line);
  });

  app.patch('/lines/:id', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateLineSchema.parse(req.body);
    const before = await prisma.line.findUnique({ where: { id }, include: { area: true } });
    if (!before) throw notFound('Line not found');
    assertSiteAccess(req.appUser, before.area.siteId);
    const line = await prisma.line.update({ where: { id }, data: body });
    await writeAudit(req, { action: 'update', entity: 'line', entityId: id, after: { name: line.name } });
    return toLineDto(line);
  });

  app.delete('/lines/:id', manage, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const before = await prisma.line.findUnique({ where: { id }, include: { area: true } });
    if (!before) throw notFound('Line not found');
    assertSiteAccess(req.appUser, before.area.siteId);
    await prisma.line.delete({ where: { id } });
    await writeAudit(req, { action: 'delete', entity: 'line', entityId: id, before: { name: before.name } });
    reply.code(204);
    return null;
  });

  app.post('/lines/reorder', manage, async (req) => {
    const { ids } = reorderSchema.parse(req.body);
    const lines = await prisma.line.findMany({ where: { id: { in: ids } }, include: { area: true } });
    for (const l of lines) assertSiteAccess(req.appUser, l.area.siteId);
    await prisma.$transaction(ids.map((id, i) => prisma.line.update({ where: { id }, data: { orderIndex: i } })));
    return { ok: true };
  });
}
