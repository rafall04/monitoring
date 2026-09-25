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
  hotspotUserBulkSchema,
  hotspotUserCreateSchema,
  hotspotUserUpdateSchema,
  idParamSchema,
  voucherGenSchema,
  type BulkCreateResult,
  type VoucherRow,
} from '@noc/shared';
import { badGateway, notFound } from '../lib/errors';
import { provisionMember, syncMemberPassword } from '../lib/member';
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
    // Errors that already carry an HTTP status (e.g. one we threw inside fn
    // after a rollback) pass through untouched instead of being re-branded
    // as a MikroTik error.
    if (err && typeof err === 'object' && 'statusCode' in err) throw err;
    throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
  } finally {
    await client.close();
  }
}

/**
 * Best-effort undo for batch creates: remove router-side hotspot users a
 * failed batch already added. `addHotspotUser` returns no id, so each row is
 * looked up by name first. Never throws — a dead router aborts the remaining
 * lookups instead of hammering it with timeouts.
 */
async function removeHotspotUsersByName(
  c: MikrotikClient,
  names: string[],
): Promise<void> {
  for (const name of names) {
    try {
      const u = await c.getHotspotUserByName(name);
      if (u?.['.id']) await c.removeHotspotUser(u['.id']);
    } catch {
      break;
    }
  }
}

function randomString(len: number, charset: string): string {
  let s = '';
  for (let i = 0; i < len; i++) s += charset[randomInt(0, charset.length)];
  return s;
}

// RouterOS has no per-user shared-users — only user-profiles carry it. A user's
// "devices" value is therefore realised by assigning a device-tier variant
// profile `<base>-<n>D` (a clone with shared-users=n that keeps the same
// noc-grp binding, hence the same app policy). devices<=1 → the base profile.
// The returned string is the profile the user should end up on.
async function resolveDeviceProfile(
  c: MikrotikClient,
  profile: string | undefined,
  sharedUsers: string | undefined,
): Promise<string | undefined> {
  if (!sharedUsers) return profile; // not requested → leave untouched
  const base = (profile || 'default').replace(/-\d+D$/, '');
  const n = parseInt(sharedUsers, 10);
  if (!Number.isFinite(n) || n <= 1) return base;
  const variant = `${base}-${n}D`;
  await c.ensureUserProfileVariant(base, variant, String(n));
  return variant;
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
    const { sharedUsers, ...body } = hotspotUserCreateSchema.parse(req.body);
    await withClient(r, async (c) => {
      body.profile = await resolveDeviceProfile(c, body.profile, sharedUsers);
      await c.addHotspotUser(body);
      // Every hotspot user gets a member account so they can self-manage
      // (status / password / kick own sessions) at the NOC login. The pair is
      // atomic: if the member login can't be created, the router row goes too.
      const prov = await provisionMember(id, body);
      if (prov !== 'created' && prov !== 'exists') {
        await removeHotspotUsersByName(c, [body.name]);
        throw badGateway('Akun member gagal dibuat — user hotspot dibatalkan');
      }
    });
    await writeAudit(req, { action: 'hotspot-user-create', entity: 'router', entityId: id, after: { name: body.name } });
    return { ok: true };
  });

  app.post('/:id/users/update', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const { id: userId, sharedUsers, ...patch } = hotspotUserUpdateSchema.parse(req.body);
    let targetName: string | undefined;
    await withClient(r, async (c) => {
      if (sharedUsers !== undefined || patch.password !== undefined) {
        // One list lookup serves both: sharedUsers needs the current profile as
        // the variant base; a password change must reach the member login.
        const users = await c.listHotspotUsers();
        const cur = users.find((u) => u['.id'] === userId);
        targetName = cur?.name;
        if (sharedUsers !== undefined) {
          patch.profile = await resolveDeviceProfile(c, patch.profile ?? cur?.profile, sharedUsers);
        }
      }
      await c.updateHotspotUser(userId, patch);
    });
    // Admin-side password change → re-hash the linked member login so the two
    // credentials never drift (member password IS the hotspot password).
    if (patch.password && targetName) {
      await syncMemberPassword(id, targetName, patch.password);
    }
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

  // Zero accumulated uptime/bytes so a user who hit a limit can log in again.
  app.post('/:id/users/reset-counters', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const { id: userId } = hotspotDisconnectSchema.parse(req.body);
    await withClient(r, (c) => c.resetHotspotUserCounters(userId));
    await writeAudit(req, {
      action: 'hotspot-user-reset-counters',
      entity: 'router',
      entityId: id,
      after: { userId },
    });
    return { ok: true };
  });

  // Batch create (e.g. RSVP import). Per-row errors are collected instead of
  // aborting the batch — one bad line must not roll back the others. But if
  // the batch itself dies mid-way, every router row + member account this call
  // already created is rolled back so nothing is left half-provisioned.
  app.post('/:id/users/bulk', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const { users: rows } = hotspotUserBulkSchema.parse(req.body);
    const results: BulkCreateResult[] = [];
    // Router rows this call created — and the subset that also got a fresh
    // member account — tracked for rollback if the batch aborts mid-way.
    const createdUsers: string[] = [];
    const createdMembers: string[] = [];
    try {
      await withClient(r, async (c) => {
        for (const u of rows) {
          const { sharedUsers, ...rest } = u;
          try {
            rest.profile = await resolveDeviceProfile(c, rest.profile, sharedUsers);
            await c.addHotspotUser(rest);
          } catch (err) {
            results.push({ name: u.name, ok: false, error: (err as Error)?.message ?? String(err) });
            continue;
          }
          // Member login is provisioned in the same pass: a failure removes the
          // router row again so the pair is never left half-created.
          const prov = await provisionMember(id, u);
          if (prov === 'created' || prov === 'exists') {
            createdUsers.push(u.name);
            if (prov === 'created') createdMembers.push(u.name);
            results.push({ name: u.name, ok: true });
          } else {
            await removeHotspotUsersByName(c, [u.name]);
            results.push({
              name: u.name,
              ok: false,
              error: 'Akun member gagal dibuat — user dibatalkan',
            });
          }
        }
      });
    } catch (err) {
      // Batch aborted (e.g. connection dropped outside a row op): undo this
      // call's footprint — member accounts created here first ('exists'
      // accounts are never touched), then the router-side users.
      if (createdMembers.length > 0) {
        await prisma.appUser
          .deleteMany({
            where: { hotspotRouterId: id, hotspotUsername: { in: createdMembers } },
          })
          .catch(() => undefined);
      }
      if (createdUsers.length > 0) {
        try {
          await withClient(r, (c) => removeHotspotUsersByName(c, createdUsers));
        } catch (e) {
          req.log.warn(
            { err: e, names: createdUsers },
            'rollback user hotspot gagal — cek router manual',
          );
        }
      }
      throw err;
    }
    await writeAudit(req, {
      action: 'hotspot-user-bulk-create',
      entity: 'router',
      entityId: id,
      after: { count: rows.length, ok: results.filter((x) => x.ok).length },
    });
    return { results };
  });

  // One-off backfill: create member logins for hotspot users that already
  // exist on the router (e.g. users created before self-service shipped, or
  // straight in Winbox). Needs passwords → listHotspotUsers(true).
  app.post('/:id/users/sync-portal', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const users = await withClient(r, (c) => c.listHotspotUsers(true));
    let created = 0;
    let existed = 0;
    let skipped = 0;
    let failed = 0;
    for (const u of users) {
      if (u.name === 'default-trial') continue; // template row, not a person
      const res = await provisionMember(id, u);
      if (res === 'created') created++;
      else if (res === 'exists') existed++;
      // Passwordless router user: there is no credential to copy — never
      // fall back to password=username, so the row is skipped.
      else if (res === 'no-password') skipped++;
      else failed++;
    }
    await writeAudit(req, {
      action: 'hotspot-portal-sync',
      entity: 'router',
      entityId: id,
      after: { created, existed, skipped, failed },
    });
    return { created, existed, skipped, failed };
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
  // The batch is atomic: if an add fails mid-way, every voucher this call
  // already wrote to the router is removed again before the error surfaces —
  // a half-generated batch would be unusable anyway (the caller never sees
  // the usernames/passwords of the rows that were rolled back).
  app.post('/:id/vouchers', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    const body = voucherGenSchema.parse(req.body);
    const vouchers: VoucherRow[] = [];
    const created: string[] = [];
    // Own client (not withClient) so a mid-batch failure can roll back on the
    // same connection that created the rows.
    const client = clientForRouter(r);
    try {
      for (let i = 0; i < body.count; i++) {
        const username = body.prefix + randomString(body.usernameLength, body.charset);
        const password = body.sameAsUsername
          ? username
          : randomString(body.passwordLength, body.charset);
        await client.addHotspotUser({
          name: username,
          password,
          profile: body.profile,
          server: body.server,
          limitUptime: body.limitUptime,
          limitBytesTotal: body.limitBytesTotal,
          comment: body.comment ?? 'voucher',
        });
        created.push(username);
        vouchers.push({ username, password, profile: body.profile });
      }
    } catch (err) {
      await removeHotspotUsersByName(client, created);
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
    } finally {
      await client.close();
    }
    await writeAudit(req, {
      action: 'voucher-generate',
      entity: 'router',
      entityId: id,
      after: { count: body.count, profile: body.profile },
    });
    return { vouchers };
  });
}
