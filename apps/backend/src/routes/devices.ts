import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@noc/server';
import {
  clientForRouter,
  computeSiteSummary,
  env,
  netwatchApiInput,
  prisma,
  publishSiteEvent,
  toDeviceDto,
} from '@noc/server';
import {
  assignDeviceSchema,
  createDeviceSchema,
  idParamSchema,
  patchDevicePositionSchema,
  reorderSchema,
  updateDeviceSchema,
} from '@noc/shared';
import { badRequest, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  assertSiteAccess,
  authenticate,
  requirePermission,
  siteScopeWhere,
} from '../plugins/rbac';

export async function deviceRoutes(app: FastifyInstance) {
  const view = { onRequest: [authenticate], preHandler: [requirePermission('device:view')] };

  app.get('/', view, async (req) => {
    const q = req.query as { siteId?: string; routerId?: string };
    const where: Prisma.DeviceWhereInput = siteScopeWhere(req.appUser);
    if (q.siteId) {
      assertSiteAccess(req.appUser, q.siteId);
      where.siteId = q.siteId;
    }
    if (q.routerId) where.routerId = q.routerId;
    const rows = await prisma.device.findMany({ where, orderBy: { name: 'asc' } });
    return rows.map(toDeviceDto);
  });

  app.get('/:id', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const d = await prisma.device.findUnique({ where: { id } });
    if (!d) throw notFound('Device not found');
    assertSiteAccess(req.appUser, d.siteId);
    return toDeviceDto(d);
  });

  app.post(
    '/',
    { onRequest: [authenticate], preHandler: [requirePermission('device:create')] },
    async (req) => {
      const body = createDeviceSchema.parse(req.body);
      const router = await prisma.routerMikrotik.findUnique({ where: { id: body.routerId } });
      if (!router) throw notFound('Router not found');
      assertSiteAccess(req.appUser, router.siteId);

      const created = await prisma.device.create({
        data: {
          routerId: router.id,
          siteId: router.siteId,
          name: body.name,
          ipAddress: body.ipAddress ?? null,
          type: body.type,
          iconKey: body.iconKey ?? null,
          iconUrl: body.iconUrl ?? null,
          geoLat: body.geoLat ?? null,
          geoLng: body.geoLng ?? null,
          mapX: body.mapX ?? null,
          mapY: body.mapY ?? null,
          isCritical: body.isCritical,
          note: body.note ?? null,
        },
      });

      let netwatchSynced = false;
      if (body.syncNetwatch && created.ipAddress) {
        try {
          const client = clientForRouter(router);
          try {
            const params = {
              webhookBaseUrl: env.PUBLIC_BASE_URL,
              routerId: router.id,
              token: router.webhookToken,
              host: created.ipAddress,
              deviceName: created.name,
            };
            await client.removeNetwatchByHost(created.ipAddress);
            await client.addNetwatch(netwatchApiInput(params));
            netwatchSynced = true;
          } finally {
            await client.close();
          }
        } catch (e) {
          req.log.warn({ e }, 'netwatch sync on device create failed');
        }
      }

      const d = netwatchSynced
        ? await prisma.device.update({ where: { id: created.id }, data: { netwatchSynced: true } })
        : created;
      const dto = toDeviceDto(d);

      await publishSiteEvent(app.redisPub, dto.siteId, {
        type: 'device.created',
        siteId: dto.siteId,
        device: dto,
      });
      await publishSiteEvent(app.redisPub, dto.siteId, {
        type: 'site.summary',
        siteId: dto.siteId,
        summary: await computeSiteSummary(prisma, dto.siteId),
      });
      await writeAudit(req, { action: 'create', entity: 'device', entityId: d.id, after: dto });
      return dto;
    },
  );

  app.patch(
    '/:id',
    { onRequest: [authenticate], preHandler: [requirePermission('device:edit-attributes')] },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = updateDeviceSchema.parse(req.body);
      const before = await prisma.device.findUnique({ where: { id } });
      if (!before) throw notFound('Device not found');
      assertSiteAccess(req.appUser, before.siteId);

      const d = await prisma.device.update({ where: { id }, data: body });
      const dto = toDeviceDto(d);
      await publishSiteEvent(app.redisPub, dto.siteId, {
        type: 'device.updated',
        siteId: dto.siteId,
        deviceId: dto.id,
        device: dto,
      });
      await writeAudit(req, {
        action: 'update',
        entity: 'device',
        entityId: id,
        before: toDeviceDto(before),
        after: dto,
      });
      return dto;
    },
  );

  // Position update (drag on the map). Separate permission from attribute edits.
  app.patch(
    '/:id/position',
    { onRequest: [authenticate], preHandler: [requirePermission('device:edit-position')] },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = patchDevicePositionSchema.parse(req.body);
      const before = await prisma.device.findUnique({ where: { id } });
      if (!before) throw notFound('Device not found');
      assertSiteAccess(req.appUser, before.siteId);

      const data: Prisma.DeviceUpdateInput = {};
      if (body.geoLat != null) data.geoLat = body.geoLat;
      if (body.geoLng != null) data.geoLng = body.geoLng;
      if (body.mapX != null) data.mapX = body.mapX;
      if (body.mapY != null) data.mapY = body.mapY;

      const d = await prisma.device.update({ where: { id }, data });
      const dto = toDeviceDto(d);
      await publishSiteEvent(app.redisPub, dto.siteId, {
        type: 'device.updated',
        siteId: dto.siteId,
        deviceId: dto.id,
        device: dto,
      });
      await writeAudit(req, {
        action: 'move',
        entity: 'device',
        entityId: id,
        before: { geoLat: before.geoLat, geoLng: before.geoLng, mapX: before.mapX, mapY: before.mapY },
        after: { geoLat: d.geoLat, geoLng: d.geoLng, mapX: d.mapX, mapY: d.mapY },
      });
      return dto;
    },
  );

  app.delete(
    '/:id',
    { onRequest: [authenticate], preHandler: [requirePermission('device:delete')] },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const before = await prisma.device.findUnique({ where: { id }, include: { router: true } });
      if (!before) throw notFound('Device not found');
      assertSiteAccess(req.appUser, before.siteId);

      if (before.netwatchSynced && before.ipAddress) {
        try {
          const client = clientForRouter(before.router);
          try {
            await client.removeNetwatchByHost(before.ipAddress);
          } finally {
            await client.close();
          }
        } catch (e) {
          req.log.warn({ e }, 'netwatch removal on device delete failed');
        }
      }

      await prisma.device.delete({ where: { id } });
      await publishSiteEvent(app.redisPub, before.siteId, {
        type: 'device.deleted',
        siteId: before.siteId,
        deviceId: id,
      });
      await publishSiteEvent(app.redisPub, before.siteId, {
        type: 'site.summary',
        siteId: before.siteId,
        summary: await computeSiteSummary(prisma, before.siteId),
      });
      await writeAudit(req, { action: 'delete', entity: 'device', entityId: id, before: toDeviceDto(before) });
      reply.code(204);
      return null;
    },
  );

  // Assign a device to an area/line (null clears). Appends to the end of the
  // target container. Operator-level.
  app.patch(
    '/:id/assign',
    { onRequest: [authenticate], preHandler: [requirePermission('device:edit-attributes')] },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = assignDeviceSchema.parse(req.body);
      const before = await prisma.device.findUnique({ where: { id } });
      if (!before) throw notFound('Device not found');
      assertSiteAccess(req.appUser, before.siteId);

      let areaId = before.areaId;
      let lineId = before.lineId;

      if (body.lineId !== undefined) {
        if (body.lineId) {
          const line = await prisma.line.findUnique({ where: { id: body.lineId }, include: { area: true } });
          if (!line || line.area.siteId !== before.siteId) throw badRequest('Line not in this site');
          lineId = line.id;
          areaId = line.areaId; // keep area consistent with the line
        } else {
          lineId = null;
        }
      }
      if (body.areaId !== undefined) {
        if (body.areaId) {
          const area = await prisma.area.findUnique({ where: { id: body.areaId } });
          if (!area || area.siteId !== before.siteId) throw badRequest('Area not in this site');
          areaId = area.id;
          if (lineId) {
            const ln = await prisma.line.findUnique({ where: { id: lineId } });
            if (!ln || ln.areaId !== areaId) lineId = null; // line no longer matches the area
          }
        } else {
          areaId = null;
          lineId = null;
        }
      }

      const orderIndex = lineId
        ? await prisma.device.count({ where: { lineId } })
        : areaId
          ? await prisma.device.count({ where: { areaId, lineId: null } })
          : await prisma.device.count({ where: { siteId: before.siteId, areaId: null } });

      const d = await prisma.device.update({ where: { id }, data: { areaId, lineId, orderIndex } });
      const dto = toDeviceDto(d);
      await publishSiteEvent(app.redisPub, dto.siteId, {
        type: 'device.updated',
        siteId: dto.siteId,
        deviceId: dto.id,
        device: dto,
      });
      await writeAudit(req, { action: 'assign', entity: 'device', entityId: id, after: { areaId: d.areaId, lineId: d.lineId } });
      return dto;
    },
  );

  // Reorder devices within their line/room (pass ids in the new order). Operator-level.
  app.post(
    '/reorder',
    { onRequest: [authenticate], preHandler: [requirePermission('device:edit-position')] },
    async (req) => {
      const { ids } = reorderSchema.parse(req.body);
      const devs = await prisma.device.findMany({ where: { id: { in: ids } }, select: { siteId: true } });
      for (const d of devs) assertSiteAccess(req.appUser, d.siteId);
      await prisma.$transaction(ids.map((id, i) => prisma.device.update({ where: { id }, data: { orderIndex: i } })));
      return { ok: true };
    },
  );
}
