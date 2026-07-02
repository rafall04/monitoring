import type { FastifyInstance } from 'fastify';
import {
  discoverRuijieProjects,
  encryptSecret,
  pollRuijieAccount,
  prisma,
  ruijieClientForAccount,
  RUIJIE_FLAP_THRESHOLD,
  RUIJIE_FLAP_WINDOW_MS,
  toRuijieAccountPublic,
  toRuijieRouterPublic,
} from '@noc/server';
import {
  createRuijieAccountSchema,
  idParamSchema,
  ruijieMonitoredGroupsSchema,
  ruijieSiteMapSchema,
  type RuijiePortEventRow,
  type RuijiePortHealth,
  type RuijiePortHealthRow,
} from '@noc/shared';
import { badGateway, conflict, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, requirePermission } from '../plugins/rbac';

// Ruijie/Reyee Cloud: read-only fleet view (status + connected-client counts)
// kept fresh by the worker poller, plus super_admin account management.
export async function ruijieRoutes(app: FastifyInstance) {
  const viewGuard = {
    onRequest: [authenticate],
    preHandler: [requirePermission('ruijie:view')],
  };
  const manageGuard = {
    onRequest: [authenticate],
    preHandler: [requirePermission('ruijie:manage')],
  };

  // ---- routers (read; data is mirrored in our DB by the worker) -------------

  app.get('/routers', viewGuard, async () => {
    const [rows, account] = await Promise.all([
      prisma.ruijieRouter.findMany({ orderBy: [{ groupName: 'asc' }, { name: 'asc' }] }),
      prisma.ruijieAccount.findFirst(), // single-account by design
    ]);
    // Resolve each router's NOC site from the account's project->site map so the
    // Site page can show its WiFi (keyed by groupName, matching the UI grouping).
    const map = (account?.groupSiteMap as Record<string, string> | null) ?? {};
    return rows.map((r) => toRuijieRouterPublic(r, map[r.groupName] ?? null));
  });

  // On-demand drill-down: live client list for one router. Clients are returned
  // per BUILDING group, so filter to the ones served by this router's AP.
  app.get('/routers/:id/clients', viewGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const router = await prisma.ruijieRouter.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!router) throw notFound('Ruijie router not found');
    const client = ruijieClientForAccount(router.account);
    try {
      const all = await client.getClients(router.cloudGroupId);
      // Clients come per BUILDING group (which may hold >1 router). Prefer the
      // ones served by this router's AP; if that linkage yields nothing (single-
      // router group, or a different serial format) fall back to the whole group
      // rather than silently hiding clients — each row carries its serving AP.
      const mine = all.filter((s) => s.apSerial === router.cloudSerial);
      return mine.length > 0 ? mine : all;
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  // Fleet-wide port health: every port the worker flagged as degraded (up but
  // slower than its learned baseline — the silent slowdown) or flapping, worst
  // first. Served entirely from our DB (mirrored by the port poller) — 0 Ruijie
  // calls, so it is safe to open + auto-refresh. This is the "check every
  // morning" board.
  app.get('/ports/health', viewGuard, async (): Promise<RuijiePortHealth> => {
    const account = await prisma.ruijieAccount.findFirst();
    const siteMap = (account?.groupSiteMap as Record<string, string> | null) ?? {};
    const [ports, flapRows] = await Promise.all([
      prisma.ruijiePort.findMany({
        include: { router: { select: { id: true, name: true, groupName: true } } },
      }),
      prisma.ruijiePortEvent.groupBy({
        by: ['routerId', 'portName'],
        where: { kind: 'link-down', at: { gte: new Date(Date.now() - RUIJIE_FLAP_WINDOW_MS) } },
        _count: { _all: true },
      }),
    ]);
    const flaps = new Map(flapRows.map((r) => [`${r.routerId}:${r.portName}`, r._count._all]));

    const rows: RuijiePortHealthRow[] = [];
    let lastPolledAt: string | null = null;
    for (const p of ports) {
      if (!lastPolledAt || p.lastSeenAt.toISOString() > lastPolledAt) {
        lastPolledAt = p.lastSeenAt.toISOString();
      }
      const flaps1h = flaps.get(`${p.routerId}:${p.portName}`) ?? 0;
      const flapping = flaps1h >= RUIJIE_FLAP_THRESHOLD;
      if (!p.degraded && !flapping) continue;
      rows.push({
        routerId: p.routerId,
        routerName: p.router.name,
        groupName: p.router.groupName,
        siteId: siteMap[p.router.groupName] ?? null,
        portName: p.portName,
        medium: p.medium,
        up: p.up,
        speedMbit: p.speedMbit,
        baselineMbit: p.baselineMbit,
        degraded: p.degraded,
        degradedSince: p.degradedSince ? p.degradedSince.toISOString() : null,
        flaps1h,
        lastSeenAt: p.lastSeenAt.toISOString(),
      });
    }
    // Degraded first (longest-standing degradation on top), then flapping (most
    // flaps first) — worst problems at the top of the board.
    rows.sort((a, b) => {
      if (a.degraded !== b.degraded) return a.degraded ? -1 : 1;
      if (a.degraded && b.degraded) return (a.degradedSince ?? '').localeCompare(b.degradedSince ?? '');
      return b.flaps1h - a.flaps1h;
    });

    return {
      summary: {
        monitoredPorts: ports.length,
        degraded: ports.filter((p) => p.degraded).length,
        flapping: [...flaps.values()].filter((n) => n >= RUIJIE_FLAP_THRESHOLD).length,
        lastPolledAt: lastPolledAt ?? (account?.lastPolledAt?.toISOString() ?? null),
      },
      rows,
    };
  });

  // Per-router port event timeline (degradation/recovery/flap) for the drill-down
  // history — "LAN1 dropped to 100M 3x this month". From our DB; 0 Ruijie calls.
  app.get('/routers/:id/port-history', viewGuard, async (req): Promise<RuijiePortEventRow[]> => {
    const { id } = idParamSchema.parse(req.params);
    const router = await prisma.ruijieRouter.findUnique({ where: { id } });
    if (!router) throw notFound('Ruijie router not found');
    const events = await prisma.ruijiePortEvent.findMany({
      where: { routerId: id },
      orderBy: { at: 'desc' },
      take: 50,
    });
    return events.map((e) => ({
      id: e.id,
      portName: e.portName,
      kind: e.kind as RuijiePortEventRow['kind'],
      fromMbit: e.fromMbit,
      toMbit: e.toMbit,
      at: e.at.toISOString(),
    }));
  });

  // On-demand drill-down: physical LAN/uplink port status (link up/down +
  // negotiated speed) straight from the cloud. Per-SN call — never polled.
  app.get('/routers/:id/ports', viewGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const router = await prisma.ruijieRouter.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!router) throw notFound('Ruijie router not found');
    const client = ruijieClientForAccount(router.account);
    try {
      return await client.getPorts(router.cloudSerial);
    } catch (e) {
      throw badGateway(`Ruijie: ${(e as Error).message}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  // ---- accounts (super_admin) -----------------------------------------------

  app.get('/accounts', manageGuard, async () => {
    const rows = await prisma.ruijieAccount.findMany({
      include: { _count: { select: { routers: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((a) => toRuijieAccountPublic(a, a._count.routers));
  });

  app.post('/accounts', manageGuard, async (req) => {
    const body = createRuijieAccountSchema.parse(req.body);
    // Single-account by design: the owner's one personal Ruijie account.
    if ((await prisma.ruijieAccount.count()) > 0) {
      throw conflict('Sudah ada akun Ruijie — hapus yang lama dulu (hanya 1 akun didukung).');
    }
    const a = await prisma.ruijieAccount.create({
      data: {
        label: body.label,
        appId: body.appId,
        appSecretEncrypted: encryptSecret(body.appSecret),
        baseUrl: body.baseUrl,
        pollIntervalSec: body.pollIntervalSec ?? null,
      },
    });
    // never audit the secret — only safe identifying fields
    await writeAudit(req, {
      action: 'create',
      entity: 'ruijie_account',
      entityId: a.id,
      after: { id: a.id, label: a.label, appId: a.appId, baseUrl: a.baseUrl },
    });
    return toRuijieAccountPublic(a, 0);
  });

  // Validate credentials live (one read-only fleet call).
  app.post('/accounts/:id/test', manageGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const acc = await prisma.ruijieAccount.findUnique({ where: { id } });
    if (!acc) throw notFound('Ruijie account not found');
    const client = ruijieClientForAccount(acc);
    try {
      const devices = await client.getDevices();
      return { ok: true, devices: devices.length, online: devices.filter((d) => d.online).length };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  // Live-discover every project/group in the account so the admin can choose
  // which to monitor. super_admin only — it hits the live API and reveals the
  // owner's personal (non-NOC) sites too.
  app.get('/accounts/:id/projects', manageGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const acc = await prisma.ruijieAccount.findUnique({ where: { id } });
    if (!acc) throw notFound('Ruijie account not found');
    try {
      return await discoverRuijieProjects(acc);
    } catch (e) {
      throw badGateway(`Ruijie: ${(e as Error).message}`);
    }
  });

  // Save the monitor allowlist, then poll once so de-selected routers are pruned
  // and newly-selected projects appear immediately (no wait for the worker tick).
  app.put('/accounts/:id/projects', manageGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { monitoredGroupIds } = ruijieMonitoredGroupsSchema.parse(req.body);
    const acc = await prisma.ruijieAccount.findUnique({ where: { id } });
    if (!acc) throw notFound('Ruijie account not found');
    const updated = await prisma.ruijieAccount.update({
      where: { id },
      data: { monitoredGroupIds },
    });
    await writeAudit(req, {
      action: 'update',
      entity: 'ruijie_account',
      entityId: id,
      after: { monitoredGroupIds },
    });
    const poll = await pollRuijieAccount(updated);
    const routerCount = await prisma.ruijieRouter.count({ where: { accountId: id } });
    return { account: toRuijieAccountPublic(updated, routerCount), poll };
  });

  // Map Ruijie projects (by groupName) to NOC sites so each site page can
  // surface its project's AP + connected-client counts. Replaces the whole map.
  app.put('/accounts/:id/site-map', manageGuard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { groupSiteMap } = ruijieSiteMapSchema.parse(req.body);
    const acc = await prisma.ruijieAccount.findUnique({ where: { id } });
    if (!acc) throw notFound('Ruijie account not found');
    const updated = await prisma.ruijieAccount.update({
      where: { id },
      data: { groupSiteMap },
    });
    await writeAudit(req, {
      action: 'update',
      entity: 'ruijie_account',
      entityId: id,
      after: { groupSiteMap },
    });
    const routerCount = await prisma.ruijieRouter.count({ where: { accountId: id } });
    return toRuijieAccountPublic(updated, routerCount);
  });

  app.delete('/accounts/:id', manageGuard, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const before = await prisma.ruijieAccount.findUnique({ where: { id } });
    if (!before) throw notFound('Ruijie account not found');
    await prisma.ruijieAccount.delete({ where: { id } }); // cascades to ruijie_router
    await writeAudit(req, {
      action: 'delete',
      entity: 'ruijie_account',
      entityId: id,
      before: { id: before.id, label: before.label, appId: before.appId },
    });
    reply.code(204);
    return null;
  });
}
