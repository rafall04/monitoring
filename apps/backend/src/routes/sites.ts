import type { FastifyInstance } from 'fastify';
import {
  computeSiteSummary,
  decryptSecret,
  encryptSecret,
  prisma,
  sendTelegram,
  toAreaDto,
  toDeviceDto,
  toSiteDto,
} from '@noc/server';
import type { ImageBounds, SiteWifiMap } from '@noc/shared';
import { REDIS_KEYS, createSiteSchema, idParamSchema, updateSiteSchema } from '@noc/shared';
import { badGateway, badRequest, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { saveUpload } from '../lib/uploads';
import {
  assertSiteAccess,
  authenticate,
  requirePermission,
  siteScopeWhere,
} from '../plugins/rbac';

export async function siteRoutes(app: FastifyInstance) {
  const view = {
    onRequest: [authenticate],
    preHandler: [requirePermission('map:view')],
  };
  const manage = {
    onRequest: [authenticate],
    preHandler: [requirePermission('site:manage')],
  };

  // List sites the user can access (super_admin: all).
  app.get('/', view, async (req) => {
    const where = siteScopeWhere(req.appUser);
    const rows = await prisma.site.findMany({
      where: where.siteId ? { id: where.siteId } : {},
      orderBy: { name: 'asc' },
    });
    return rows.map(toSiteDto);
  });

  app.get('/:id', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const s = await prisma.site.findUnique({ where: { id } });
    if (!s) throw notFound('Site not found');
    return toSiteDto(s);
  });

  // Map data: all devices for the site.
  app.get('/:id/devices', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const devices = await prisma.device.findMany({
      where: { siteId: id },
      orderBy: { name: 'asc' },
    });
    return devices.map(toDeviceDto);
  });

  app.get('/:id/summary', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    return computeSiteSummary(prisma, id);
  });

  // Device⇄WiFi correlation (which Ruijie AP each device is on). Read-only cache
  // built by the worker; viewers may read it. Empty map until the first enrich.
  app.get('/:id/wifi', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const raw = await app.redisPub.get(REDIS_KEYS.siteWifi(id));
    const empty: SiteWifiMap = { updatedAt: null, links: {} };
    if (!raw) return empty;
    try {
      return JSON.parse(raw) as SiteWifiMap;
    } catch {
      return empty;
    }
  });

  // Factory structure: areas (with their ordered lines) for the swimlane view.
  app.get('/:id/areas', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const areas = await prisma.area.findMany({
      where: { siteId: id },
      orderBy: { orderIndex: 'asc' },
      include: { lines: { orderBy: { orderIndex: 'asc' } } },
    });
    return areas.map(toAreaDto);
  });

  app.post('/', manage, async (req) => {
    const { telegramBotToken, ...body } = createSiteSchema.parse(req.body);
    const s = await prisma.site.create({
      data: {
        companyId: body.companyId,
        name: body.name,
        region: body.region ?? null,
        mapMode: body.mapMode,
        geoCenterLat: body.geoCenterLat ?? null,
        geoCenterLng: body.geoCenterLng ?? null,
        defaultZoom: body.defaultZoom,
        imageBounds: (body.imageBounds as ImageBounds | undefined) ?? undefined,
        floorplanWidth: body.floorplanWidth ?? null,
        floorplanHeight: body.floorplanHeight ?? null,
        telegramMode: body.telegramMode ?? 'off',
        telegramChatId: body.telegramChatId ?? null,
        ...(telegramBotToken ? { telegramBotEncrypted: encryptSecret(telegramBotToken) } : {}),
      },
    });
    await writeAudit(req, { action: 'create', entity: 'site', entityId: s.id, after: toSiteDto(s) });
    return toSiteDto(s);
  });

  app.patch('/:id', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { telegramBotToken, ...body } = updateSiteSchema.parse(req.body);
    assertSiteAccess(req.appUser, id);
    const before = await prisma.site.findUnique({ where: { id } });
    if (!before) throw notFound('Site not found');
    const s = await prisma.site.update({
      where: { id },
      data: {
        ...body,
        imageBounds:
          body.imageBounds === undefined
            ? undefined
            : (body.imageBounds as ImageBounds | null) ?? undefined,
        ...(telegramBotToken !== undefined
          ? { telegramBotEncrypted: telegramBotToken ? encryptSecret(telegramBotToken) : null }
          : {}),
      },
    });
    await writeAudit(req, {
      action: 'update',
      entity: 'site',
      entityId: id,
      before: toSiteDto(before),
      after: toSiteDto(s),
    });
    return toSiteDto(s);
  });

  app.delete('/:id', manage, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const before = await prisma.site.findUnique({ where: { id } });
    if (!before) throw notFound('Site not found');
    await prisma.site.delete({ where: { id } });
    await writeAudit(req, { action: 'delete', entity: 'site', entityId: id, before });
    reply.code(204);
    return null;
  });

  // Upload a floorplan image. Pass ?width=&height= (pixels) so we can set the
  // CRS.Simple bounds. Switches the site to floorplan mode.
  app.post('/:id/floorplan', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const site = await prisma.site.findUnique({ where: { id } });
    if (!site) throw notFound('Site not found');
    const part = await req.file();
    if (!part) throw badRequest('No file uploaded');
    const { url } = await saveUpload(part, 'floorplan');

    const q = req.query as { width?: string; height?: string };
    const width = q.width ? Number(q.width) : site.floorplanWidth;
    const height = q.height ? Number(q.height) : site.floorplanHeight;
    const imageBounds: ImageBounds | undefined =
      width && height ? [[0, 0], [height, width]] : undefined;

    const updated = await prisma.site.update({
      where: { id },
      data: {
        floorplanImageUrl: url,
        floorplanWidth: width ?? null,
        floorplanHeight: height ?? null,
        mapMode: 'floorplan',
        ...(imageBounds ? { imageBounds } : {}),
      },
    });
    await writeAudit(req, {
      action: 'upload-floorplan',
      entity: 'site',
      entityId: id,
      after: { url, width, height },
    });
    return toSiteDto(updated);
  });

  // Send a test Telegram message using the site's saved config.
  app.post('/:id/telegram/test', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const site = await prisma.site.findUnique({ where: { id } });
    if (!site) throw notFound('Site not found');
    if (!site.telegramBotEncrypted || !site.telegramChatId)
      throw badRequest('Set the bot token and chat id first');
    const ok = await sendTelegram(
      decryptSecret(site.telegramBotEncrypted),
      site.telegramChatId,
      `✅ NOC test — ${site.name}\nTelegram alert aktif.`,
    );
    if (!ok) throw badGateway('Telegram send failed — cek token / chat id / koneksi');
    await writeAudit(req, { action: 'telegram-test', entity: 'site', entityId: id });
    return { ok: true };
  });
}
