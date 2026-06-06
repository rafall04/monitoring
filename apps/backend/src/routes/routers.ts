import type { FastifyInstance } from 'fastify';
import {
  clientForRouter,
  decryptSecret,
  encryptSecret,
  env,
  generateNetwatchCli,
  generateToken,
  getNetwatchConfig,
  netwatchApiInput,
  prisma,
  scriptFor,
  toRouterPublic,
  type Prisma,
} from '@noc/server';
import {
  createRouterSchema,
  idParamSchema,
  updateRouterSchema,
  type RouterResource,
} from '@noc/shared';
import { badGateway, badRequest, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  assertSiteAccess,
  authenticate,
  requirePermission,
  siteScopeWhere,
} from '../plugins/rbac';

export async function routerRoutes(app: FastifyInstance) {
  const view = { onRequest: [authenticate], preHandler: [requirePermission('map:view')] };
  const manage = { onRequest: [authenticate], preHandler: [requirePermission('site:manage')] };
  const testGuard = { onRequest: [authenticate], preHandler: [requirePermission('router:test')] };
  const netwatchGuard = { onRequest: [authenticate], preHandler: [requirePermission('netwatch:manage')] };

  app.get('/', view, async (req) => {
    const q = req.query as { siteId?: string };
    const where = siteScopeWhere(req.appUser);
    if (q.siteId) {
      assertSiteAccess(req.appUser, q.siteId);
      where.siteId = { in: [q.siteId] };
    }
    const rows = await prisma.routerMikrotik.findMany({ where, orderBy: { name: 'asc' } });
    return rows.map(toRouterPublic);
  });

  app.get('/:id', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await prisma.routerMikrotik.findUnique({ where: { id } });
    if (!r) throw notFound('Router not found');
    assertSiteAccess(req.appUser, r.siteId);
    return toRouterPublic(r);
  });

  app.post('/', manage, async (req) => {
    const body = createRouterSchema.parse(req.body);
    assertSiteAccess(req.appUser, body.siteId);
    const r = await prisma.routerMikrotik.create({
      data: {
        siteId: body.siteId,
        name: body.name,
        host: body.host,
        apiPort: body.apiPort,
        useTls: body.useTls,
        username: body.username,
        passwordEncrypted: encryptSecret(body.password),
        routerosVersion: body.routerosVersion,
        pollIntervalSec: body.pollIntervalSec ?? null,
        webhookToken: generateToken(),
      },
    });
    await writeAudit(req, { action: 'create', entity: 'router', entityId: r.id, after: toRouterPublic(r) });
    return toRouterPublic(r);
  });

  app.patch('/:id', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateRouterSchema.parse(req.body);
    const before = await prisma.routerMikrotik.findUnique({ where: { id } });
    if (!before) throw notFound('Router not found');
    assertSiteAccess(req.appUser, before.siteId);

    const { password, ...rest } = body;
    const r = await prisma.routerMikrotik.update({
      where: { id },
      data: {
        ...rest,
        ...(password && password.length > 0
          ? { passwordEncrypted: encryptSecret(password) }
          : {}),
      },
    });
    await writeAudit(req, {
      action: 'update',
      entity: 'router',
      entityId: id,
      before: toRouterPublic(before),
      after: toRouterPublic(r),
    });
    return toRouterPublic(r);
  });

  app.delete('/:id', manage, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const before = await prisma.routerMikrotik.findUnique({ where: { id } });
    if (!before) throw notFound('Router not found');
    assertSiteAccess(req.appUser, before.siteId);
    await prisma.routerMikrotik.delete({ where: { id } });
    await writeAudit(req, { action: 'delete', entity: 'router', entityId: id, before: toRouterPublic(before) });
    reply.code(204);
    return null;
  });

  // Test Connection: returns identity + resource if reachable.
  app.post('/:id/test', testGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await prisma.routerMikrotik.findUnique({ where: { id } });
    if (!r) throw notFound('Router not found');
    assertSiteAccess(req.appUser, r.siteId);
    const client = clientForRouter(r);
    try {
      const resource: RouterResource = await client.getResource();
      await prisma.routerMikrotik.update({
        where: { id },
        data: {
          status: 'online',
          lastSeenAt: new Date(),
          resourceCache: resource as unknown as Prisma.InputJsonValue,
        },
      });
      return { ok: true, resource };
    } catch (err) {
      await prisma.routerMikrotik.update({ where: { id }, data: { status: 'offline' } });
      throw badGateway(`Connection failed: ${(err as Error)?.message ?? err}`);
    } finally {
      await client.close();
    }
  });

  // Generate copy-paste Netwatch script for a single host.
  app.get('/:id/netwatch/script', netwatchGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const q = req.query as { host?: string; name?: string };
    if (!q.host) throw badRequest('Query param "host" is required');
    const r = await prisma.routerMikrotik.findUnique({ where: { id } });
    if (!r) throw notFound('Router not found');
    assertSiteAccess(req.appUser, r.siteId);
    const site = await prisma.site.findUnique({ where: { id: r.siteId } });
    const cfg = await getNetwatchConfig();
    const telegram =
      site && site.telegramMode === 'router' && site.telegramBotEncrypted && site.telegramChatId
        ? { botToken: decryptSecret(site.telegramBotEncrypted), chatId: site.telegramChatId, siteName: site.name }
        : undefined;
    const params = {
      webhookBaseUrl: env.PUBLIC_BASE_URL,
      routerId: r.id,
      token: r.webhookToken,
      host: q.host,
      deviceName: q.name,
      telegram,
      cfg,
    };
    return {
      webhookUrl: `${env.PUBLIC_BASE_URL}/api/v1/webhook/netwatch`,
      telegramMode: site?.telegramMode ?? 'off',
      cli: generateNetwatchCli(params),
      upScript: scriptFor(params, 'up'),
      downScript: scriptFor(params, 'down'),
    };
  });

  // Auto-install Netwatch entries for every device on this router (best effort).
  app.post('/:id/netwatch/install', netwatchGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await prisma.routerMikrotik.findUnique({
      where: { id },
      include: { devices: true },
    });
    if (!r) throw notFound('Router not found');
    assertSiteAccess(req.appUser, r.siteId);
    const site = await prisma.site.findUnique({ where: { id: r.siteId } });
    const routerTelegram =
      site && site.telegramMode === 'router' && site.telegramBotEncrypted && site.telegramChatId
        ? { botToken: decryptSecret(site.telegramBotEncrypted), chatId: site.telegramChatId, siteName: site.name }
        : undefined;
    const cfg = await getNetwatchConfig();

    const client = clientForRouter(r);
    const results: Array<{ device: string; ok: boolean; reason?: string }> = [];
    try {
      for (const d of r.devices) {
        if (!d.ipAddress) {
          results.push({ device: d.name, ok: false, reason: 'no ip address' });
          continue;
        }
        try {
          const params = {
            webhookBaseUrl: env.PUBLIC_BASE_URL,
            routerId: r.id,
            token: r.webhookToken,
            host: d.ipAddress,
            deviceName: d.name,
            telegram: d.isCritical ? routerTelegram : undefined, // alert critical devices only
            cfg,
          };
          await client.removeNetwatchByHost(d.ipAddress);
          await client.addNetwatch(netwatchApiInput(params));
          await prisma.device.update({ where: { id: d.id }, data: { netwatchSynced: true } });
          results.push({ device: d.name, ok: true });
        } catch (e) {
          results.push({ device: d.name, ok: false, reason: (e as Error)?.message ?? String(e) });
        }
      }
    } finally {
      await client.close();
    }
    await writeAudit(req, { action: 'netwatch-install', entity: 'router', entityId: id, after: { results } });
    return { results };
  });

  // Import devices from the router's EXISTING Netwatch table (auto-discovery).
  app.post('/:id/import-netwatch', netwatchGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await prisma.routerMikrotik.findUnique({ where: { id } });
    if (!r) throw notFound('Router not found');
    assertSiteAccess(req.appUser, r.siteId);

    const existing = await prisma.device.findMany({ where: { routerId: r.id }, select: { ipAddress: true } });
    const known = new Set(existing.map((d) => d.ipAddress).filter((x): x is string => Boolean(x)));

    const client = clientForRouter(r);
    let imported = 0;
    let skipped = 0;
    const created: string[] = [];
    try {
      const entries = await client.listNetwatch();
      let order = await prisma.device.count({ where: { siteId: r.siteId, areaId: null } });
      for (const e of entries) {
        if (!e.host || known.has(e.host)) {
          skipped++;
          continue;
        }
        const name = (e.comment || e.name || e.host).slice(0, 120);
        const type = guessDeviceType(`${e.comment ?? ''} ${e.name ?? ''} ${name}`);
        const status = e.status === 'up' ? 'up' : e.status === 'down' ? 'down' : 'unknown';
        const d = await prisma.device.create({
          data: { routerId: r.id, siteId: r.siteId, name, ipAddress: e.host, type, status, netwatchSynced: true, orderIndex: order++ },
        });
        created.push(d.name);
        known.add(e.host);
        imported++;
      }
    } catch (err) {
      throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
    } finally {
      await client.close();
    }
    await writeAudit(req, { action: 'netwatch-import', entity: 'router', entityId: id, after: { imported, skipped } });
    return { imported, skipped, devices: created };
  });
}

/** Best-effort device-type guess from a Netwatch comment/name during import. */
function guessDeviceType(s: string): string {
  const t = s.toLowerCase();
  if (t.includes('gtex') || t.includes('gtek')) return 'gtex';
  if (t.includes('qcpad') || t.includes('qc')) return 'qcpad';
  if (t.includes('andon') || t.includes('tv')) return 'androidtv';
  if (t.includes('mikrotik') || t.includes('router') || /\brb\d/.test(t)) return 'router';
  if (t.includes('switch') || t.includes('sw-')) return 'switch';
  if (t.includes('access point') || t.includes('access-point') || /\bap\b/.test(t)) return 'access_point';
  if (t.includes('cctv') || t.includes('camera') || t.includes('cam')) return 'cctv';
  if (t.includes('server') || t.includes('erp') || t.includes('nas')) return 'server';
  if (t.includes('olt')) return 'olt';
  if (t.includes('onu') || t.includes('ont')) return 'onu';
  if (t.includes('print')) return 'printer';
  return 'other';
}
