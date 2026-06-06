import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@noc/server';
import {
  clientForRouter,
  computeSiteSummary,
  decryptSecret,
  env,
  getNetwatchConfig,
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
    const q = req.query as {
      siteId?: string;
      routerId?: string;
      search?: string;
      status?: string;
      critical?: string;
      take?: string;
    };
    // Hard cap so a runaway client cannot pull a million-row table at once.
    // The map page needs every device on a site, so the cap is generous.
    const take = Math.min(5000, Math.max(1, Number(q.take) || 5000));

    const where: Prisma.DeviceWhereInput = siteScopeWhere(req.appUser);
    if (q.siteId) {
      assertSiteAccess(req.appUser, q.siteId);
      where.siteId = q.siteId;
    }
    if (q.routerId) where.routerId = q.routerId;
    if (q.critical === '1') where.isCritical = true;
    if (q.status === 'up' || q.status === 'down' || q.status === 'unknown') {
      where.status = q.status;
    }
    const s = (q.search ?? '').trim();
    if (s) {
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { ipAddress: { contains: s, mode: 'insensitive' } },
        { note: { contains: s, mode: 'insensitive' } },
      ];
    }

    const rows = await prisma.device.findMany({
      where,
      orderBy: { name: 'asc' },
      take,
    });
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
      let netwatchError: string | undefined;
      if (body.syncNetwatch && created.ipAddress) {
        const site = await prisma.site.findUnique({ where: { id: created.siteId } });
        try {
          await installNetwatchForDevice(
            router,
            { name: created.name, ipAddress: created.ipAddress, isCritical: created.isCritical },
            site,
          );
          netwatchSynced = true;
        } catch (e) {
          netwatchError = (e as Error)?.message ?? String(e);
          req.log.warn({ e }, 'netwatch sync on device create failed');
        }
      } else if (body.syncNetwatch && !created.ipAddress) {
        netwatchError = 'Device has no IP address';
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
      // netwatchError is a transient hint for the UI; it is not persisted.
      return netwatchError ? { ...dto, netwatchError } : dto;
    },
  );

  app.patch(
    '/:id',
    { onRequest: [authenticate], preHandler: [requirePermission('device:edit-attributes')] },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const { syncNetwatch, ...patch } = updateDeviceSchema.parse(req.body);
      const before = await prisma.device.findUnique({ where: { id } });
      if (!before) throw notFound('Device not found');
      assertSiteAccess(req.appUser, before.siteId);

      let d = await prisma.device.update({ where: { id }, data: patch });

      let netwatchError: string | undefined;
      if (syncNetwatch) {
        if (!d.ipAddress) {
          netwatchError = 'Device has no IP address';
        } else {
          const router = await prisma.routerMikrotik.findUnique({ where: { id: d.routerId } });
          const site = await prisma.site.findUnique({ where: { id: d.siteId } });
          if (!router) {
            netwatchError = 'Router not found';
          } else {
            try {
              await installNetwatchForDevice(
                router,
                { name: d.name, ipAddress: d.ipAddress, isCritical: d.isCritical },
                site,
                // if the IP changed, drop the stale entry for the previous IP too
                before.ipAddress ? [before.ipAddress] : [],
              );
              d = await prisma.device.update({ where: { id }, data: { netwatchSynced: true } });
            } catch (e) {
              netwatchError = (e as Error)?.message ?? String(e);
              req.log.warn({ e }, 'netwatch re-sync on device update failed');
            }
          }
        }
      }

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
      return netwatchError ? { ...dto, netwatchError } : dto;
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

/**
 * (Re)install the Netwatch entry for ONE device on its router. Mirrors the
 * router-wide install: includes the direct-to-Telegram alert when the site is in
 * `router` mode and the device is critical. `alsoRemoveHosts` clears stale
 * entries (e.g. a previous IP) on a best-effort basis. Throws on connect/API
 * failure so the caller can surface the reason to the user.
 */
async function installNetwatchForDevice(
  router: {
    id: string;
    webhookToken: string;
    host: string;
    apiPort: number;
    useTls: boolean;
    username: string;
    passwordEncrypted: string;
    routerosVersion: string;
  },
  device: { name: string; ipAddress: string; isCritical: boolean },
  site: { name: string; telegramMode: string; telegramBotEncrypted: string | null; telegramChatId: string | null } | null,
  alsoRemoveHosts: string[] = [],
): Promise<void> {
  const telegram =
    device.isCritical &&
    site &&
    site.telegramMode === 'router' &&
    site.telegramBotEncrypted &&
    site.telegramChatId
      ? { botToken: decryptSecret(site.telegramBotEncrypted), chatId: site.telegramChatId, siteName: site.name }
      : undefined;

  // Pull the global Netwatch config (interval/timeout/custom script tail/TG
  // templates) so super_admin's Settings drive what actually gets pushed.
  const cfg = await getNetwatchConfig();
  const client = clientForRouter(router);
  try {
    for (const h of alsoRemoveHosts) {
      if (h && h !== device.ipAddress) {
        try {
          await client.removeNetwatchByHost(h);
        } catch {
          /* best effort — a missing stale entry is fine */
        }
      }
    }
    await client.removeNetwatchByHost(device.ipAddress);
    await client.addNetwatch(
      netwatchApiInput({
        webhookBaseUrl: env.PUBLIC_BASE_URL,
        routerId: router.id,
        token: router.webhookToken,
        host: device.ipAddress,
        deviceName: device.name,
        telegram,
        cfg,
      }),
    );
  } finally {
    await client.close();
  }
}
