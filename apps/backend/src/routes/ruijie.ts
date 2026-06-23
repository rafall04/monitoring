import type { FastifyInstance } from 'fastify';
import {
  discoverRuijieProjects,
  encryptSecret,
  pollRuijieAccount,
  prisma,
  ruijieClientForAccount,
  toRuijieAccountPublic,
  toRuijieRouterPublic,
} from '@noc/server';
import { createRuijieAccountSchema, idParamSchema, ruijieMonitoredGroupsSchema } from '@noc/shared';
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
    const rows = await prisma.ruijieRouter.findMany({
      orderBy: [{ groupName: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toRuijieRouterPublic);
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
