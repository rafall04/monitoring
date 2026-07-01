import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clientForRouter,
  prisma,
  type MikrotikClient,
  type RouterMikrotik,
} from '@noc/server';
import {
  addSimpleQueueSchema,
  idParamSchema,
  setLeaseRateSchema,
  updateSimpleQueueSchema,
} from '@noc/shared';
import { z } from 'zod';
import { badGateway, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission } from '../plugins/rbac';

const rosId = z.string().min(1).max(64);

async function routerWithAccess(req: FastifyRequest, routerId: string): Promise<RouterMikrotik> {
  const r = await prisma.routerMikrotik.findUnique({ where: { id: routerId } });
  if (!r) throw notFound('Router not found');
  assertSiteAccess(req.appUser, r.siteId);
  return r;
}

async function withClient<T>(
  router: RouterMikrotik,
  fn: (c: MikrotikClient) => Promise<T>,
): Promise<T> {
  const client = clientForRouter(router);
  try {
    return await fn(client);
  } catch (err) {
    throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
  } finally {
    await client.close();
  }
}

async function backup(c: MikrotikClient): Promise<'saved' | 'failed'> {
  try {
    await c.saveBackup('noc-autobak');
    return 'saved';
  } catch {
    return 'failed';
  }
}

// Bandwidth / QoS: simple queues (per device/subnet limits) + DHCP lease
// rate-limit. Writes require bandwidth:manage; audited + config-backed-up.
export async function bandwidthRoutes(app: FastifyInstance) {
  const view = { onRequest: [authenticate], preHandler: [requirePermission('bandwidth:view')] };
  const manage = { onRequest: [authenticate], preHandler: [requirePermission('bandwidth:manage')] };

  app.get('/:id/queues', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listSimpleQueues());
  });

  app.post('/:id/queues', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = addSimpleQueueSchema.parse(req.body);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.addSimpleQueue(body);
      return bak;
    });
    await writeAudit(req, {
      action: 'bandwidth-queue-add',
      entity: 'router',
      entityId: id,
      after: { ...body, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.patch('/:id/queues/:qid', manage, async (req) => {
    const { id, qid } = z.object({ id: z.string(), qid: rosId }).parse(req.params);
    const { maxLimit } = updateSimpleQueueSchema.parse(req.body);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.setSimpleQueueMax(qid, maxLimit);
      return bak;
    });
    await writeAudit(req, {
      action: 'bandwidth-queue-set',
      entity: 'router',
      entityId: id,
      after: { qid, maxLimit, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.delete('/:id/queues/:qid', manage, async (req) => {
    const { id, qid } = z.object({ id: z.string(), qid: rosId }).parse(req.params);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.removeSimpleQueue(qid);
      return bak;
    });
    await writeAudit(req, {
      action: 'bandwidth-queue-remove',
      entity: 'router',
      entityId: id,
      after: { qid, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.get('/:id/leases', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listDhcpLeases());
  });

  app.patch('/:id/leases/:lid', manage, async (req) => {
    const { id, lid } = z.object({ id: z.string(), lid: rosId }).parse(req.params);
    const { rateLimit } = setLeaseRateSchema.parse(req.body);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.setLeaseRateLimit(lid, rateLimit);
      return bak;
    });
    await writeAudit(req, {
      action: rateLimit ? 'bandwidth-lease-limit' : 'bandwidth-lease-unlimit',
      entity: 'router',
      entityId: id,
      after: { lid, rateLimit, backup: result },
    });
    return { ok: true, backup: result };
  });
}
