import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clientForRouter,
  prisma,
  type MikrotikClient,
  type RouterMikrotik,
} from '@noc/server';
import {
  diagIpSchema,
  idParamSchema,
  pingQuerySchema,
  poeCycleSchema,
} from '@noc/shared';
import { badGateway, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission } from '../plugins/rbac';

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

// Diagnostics (read-only ping/traceroute/net-info/log) + one remediation action
// (PoE power-cycle). Reads need device:diagnose; the power-cycle needs
// device:remediate and is backed up + audited like every other config write.
export async function diagnosticsRoutes(app: FastifyInstance) {
  const diagnose = { onRequest: [authenticate], preHandler: [requirePermission('device:diagnose')] };
  const remediate = { onRequest: [authenticate], preHandler: [requirePermission('device:remediate')] };

  app.get('/:id/ping', diagnose, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { ip, count } = pingQuerySchema.parse(req.query);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.pingHost(ip, count));
  });

  app.get('/:id/traceroute', diagnose, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { ip } = diagIpSchema.parse(req.query);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.tracePath(ip));
  });

  app.get('/:id/net-info', diagnose, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { ip } = diagIpSchema.parse(req.query);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.deviceNetInfo(ip));
  });

  app.get('/:id/log', diagnose, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.recentLog(50));
  });

  app.post('/:id/poe-cycle', remediate, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const { port } = poeCycleSchema.parse(req.body);
    const r = await routerWithAccess(req, id);
    const backup = await withClient(r, async (c) => {
      let bak: 'saved' | 'failed';
      try {
        await c.saveBackup('noc-autobak');
        bak = 'saved';
      } catch {
        bak = 'failed';
      }
      await c.poePowerCycle(port);
      return bak;
    });
    await writeAudit(req, {
      action: 'device-poe-cycle',
      entity: 'router',
      entityId: id,
      after: { port, backup },
    });
    return { ok: true, backup };
  });
}
