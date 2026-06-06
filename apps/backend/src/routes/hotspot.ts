import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clientForRouter,
  prisma,
  type MikrotikClient,
  type RouterMikrotik,
} from '@noc/server';
import {
  hotspotDisconnectSchema,
  hotspotProfileUpsertSchema,
  hotspotUserCreateSchema,
  hotspotUserUpdateSchema,
  idParamSchema,
  voucherGenSchema,
  type VoucherRow,
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

function randomString(len: number, charset: string): string {
  let s = '';
  for (let i = 0; i < len; i++) s += charset[randomInt(0, charset.length)];
  return s;
}

export async function hotspotRoutes(app: FastifyInstance) {
  const view = { onRequest: [authenticate], preHandler: [requirePermission('hotspot:view')] };
  const manage = { onRequest: [authenticate], preHandler: [requirePermission('hotspot:manage-users')] };
  const disconnect = { onRequest: [authenticate], preHandler: [requirePermission('hotspot:disconnect')] };
  const manageProfiles = { onRequest: [authenticate], preHandler: [requirePermission('hotspot:manage-profiles')] };

  app.get('/:id/users', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listHotspotUsers());
  });

  app.get('/:id/profiles', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listHotspotProfiles());
  });

  // Create (no id) or update (with id) a hotspot user-profile.
  app.post('/:id/profiles', manageProfiles, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const { id: profileId, ...rest } = hotspotProfileUpsertSchema.parse(req.body);
    await withClient(r, (c) =>
      profileId ? c.updateHotspotProfile(profileId, rest) : c.addHotspotProfile(rest),
    );
    await writeAudit(req, {
      action: profileId ? 'hotspot-profile-update' : 'hotspot-profile-create',
      entity: 'router',
      entityId: id,
      after: { name: rest.name },
    });
    return { ok: true };
  });

  app.get('/:id/active', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listHotspotActive());
  });

  app.get('/:id/servers', view, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listHotspotServers());
  });

  app.post('/:id/users', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const body = hotspotUserCreateSchema.parse(req.body);
    await withClient(r, (c) => c.addHotspotUser(body));
    await writeAudit(req, { action: 'hotspot-user-create', entity: 'router', entityId: id, after: { name: body.name } });
    return { ok: true };
  });

  app.post('/:id/users/update', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const { id: userId, ...patch } = hotspotUserUpdateSchema.parse(req.body);
    await withClient(r, (c) => c.updateHotspotUser(userId, patch));
    await writeAudit(req, { action: 'hotspot-user-update', entity: 'router', entityId: id, after: { userId } });
    return { ok: true };
  });

  app.post('/:id/users/delete', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const { id: userId } = hotspotDisconnectSchema.parse(req.body);
    await withClient(r, (c) => c.removeHotspotUser(userId));
    await writeAudit(req, { action: 'hotspot-user-delete', entity: 'router', entityId: id, after: { userId } });
    return { ok: true };
  });

  app.post('/:id/active/disconnect', disconnect, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const { id: activeId } = hotspotDisconnectSchema.parse(req.body);
    await withClient(r, (c) => c.disconnectHotspotActive(activeId));
    await writeAudit(req, { action: 'hotspot-disconnect', entity: 'router', entityId: id, after: { activeId } });
    return { ok: true };
  });

  // Batch voucher generator. Returns rows; CSV export is done client-side.
  app.post('/:id/vouchers', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const body = voucherGenSchema.parse(req.body);
    const vouchers: VoucherRow[] = [];
    await withClient(r, async (c) => {
      for (let i = 0; i < body.count; i++) {
        const username = body.prefix + randomString(body.usernameLength, body.charset);
        const password = body.sameAsUsername
          ? username
          : randomString(body.passwordLength, body.charset);
        await c.addHotspotUser({
          name: username,
          password,
          profile: body.profile,
          server: body.server,
          limitUptime: body.limitUptime,
          limitBytesTotal: body.limitBytesTotal,
          comment: body.comment ?? 'voucher',
        });
        vouchers.push({ username, password, profile: body.profile });
      }
    });
    await writeAudit(req, {
      action: 'voucher-generate',
      entity: 'router',
      entityId: id,
      after: { count: body.count, profile: body.profile },
    });
    return { vouchers };
  });
}
