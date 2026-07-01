import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clientForRouter,
  prisma,
  type MikrotikClient,
  type RouterMikrotik,
} from '@noc/server';
import {
  BLOCK_SERVICES,
  addAddressListSchema,
  createIntentSchema,
  idParamSchema,
  toggleBlockSchema,
} from '@noc/shared';
import { z } from 'zod';
import { badGateway, badRequest, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission } from '../plugins/rbac';

// RouterOS ids look like "*E" / "*1D" — not cuids, so a permissive string.
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

/** Best-effort restore point before a write. Never blocks the (reversible)
 *  action; returns whether it saved so the UI can warn if not. */
async function backup(c: MikrotikClient): Promise<'saved' | 'failed'> {
  try {
    await c.saveBackup('noc-autobak');
    return 'saved';
  } catch {
    return 'failed';
  }
}

// Access control: firewall block toggles + block address-lists. Writes require
// firewall:manage; every change is audited and preceded by a config backup.
export async function firewallRoutes(app: FastifyInstance) {
  const view = { onRequest: [authenticate], preHandler: [requirePermission('firewall:view')] };
  const manage = { onRequest: [authenticate], preHandler: [requirePermission('firewall:manage')] };

  app.get('/:id/blocks', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listFirewallBlocks());
  });

  app.post('/:id/blocks/:ruleId/toggle', manage, async (req) => {
    const { id, ruleId } = z.object({ id: z.string(), ruleId: rosId }).parse(req.params);
    const { active } = toggleBlockSchema.parse(req.body);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.setBlockActive(ruleId, active);
      return bak;
    });
    await writeAudit(req, {
      action: active ? 'firewall-block-on' : 'firewall-block-off',
      entity: 'router',
      entityId: id,
      after: { ruleId, active, backup: result },
    });
    return { ok: true, backup: result };
  });

  // ---- Managed block system (clean noc-block chain + preset services) -------

  app.get('/:id/intents', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listBlockIntents());
  });

  app.post('/:id/intents', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = createIntentSchema.parse(req.body);
    const svc = BLOCK_SERVICES.find((s) => s.key === body.service);
    if (!svc) throw badRequest(`Layanan tidak dikenal: ${body.service}`);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.ensureBlockChain();
      await c.ensureServiceDomains(svc.key, svc.domains);
      await c.createIntent({ group: body.group, service: svc.key });
      return bak;
    });
    await writeAudit(req, {
      action: 'block-intent-create',
      entity: 'router',
      entityId: id,
      after: { ...body, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.post('/:id/intents/:ruleId/toggle', manage, async (req) => {
    const { id, ruleId } = z.object({ id: z.string(), ruleId: rosId }).parse(req.params);
    const { active } = toggleBlockSchema.parse(req.body);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.setIntentActive(ruleId, active);
      return bak;
    });
    await writeAudit(req, {
      action: active ? 'block-intent-on' : 'block-intent-off',
      entity: 'router',
      entityId: id,
      after: { ruleId, active, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.delete('/:id/intents/:ruleId', manage, async (req) => {
    const { id, ruleId } = z.object({ id: z.string(), ruleId: rosId }).parse(req.params);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.removeIntent(ruleId);
      return bak;
    });
    await writeAudit(req, {
      action: 'block-intent-remove',
      entity: 'router',
      entityId: id,
      after: { ruleId, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.get('/:id/address-list', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const list = z.object({ list: z.string().max(64).optional() }).parse(req.query).list;
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listAddressListEntries(list));
  });

  app.post('/:id/address-list', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = addAddressListSchema.parse(req.body);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.addAddressListEntry(body);
      return bak;
    });
    await writeAudit(req, {
      action: 'firewall-addresslist-add',
      entity: 'router',
      entityId: id,
      after: { ...body, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.delete('/:id/address-list/:entryId', manage, async (req) => {
    const { id, entryId } = z.object({ id: z.string(), entryId: rosId }).parse(req.params);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.removeAddressListEntry(entryId);
      return bak;
    });
    await writeAudit(req, {
      action: 'firewall-addresslist-remove',
      entity: 'router',
      entityId: id,
      after: { entryId, backup: result },
    });
    return { ok: true, backup: result };
  });
}
