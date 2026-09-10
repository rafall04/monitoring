import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clientForRouter,
  prisma,
  type MikrotikClient,
  type RouterMikrotik,
} from '@noc/server';
import {
  BLOCK_SERVICES,
  accessMemberSchema,
  accessPolicySchema,
  accessProfileCreateSchema,
  addAddressListSchema,
  createIntentSchema,
  idParamSchema,
  toggleBlockSchema,
} from '@noc/shared';
import { z } from 'zod';
import { badGateway, badRequest, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission } from '../plugins/rbac';

// RouterOS ids look like "*E" / "*1D"; managed-intent keys are '<group>|<service>'.
// Both are permissive strings — 128 comfortably fits a long group+service composite.
const rosId = z.string().min(1).max(128);

// Access-profile name = a group name that flows into list names + rule comments.
const accessName = z.string().min(1).max(48).regex(/^[A-Za-z0-9._-]+$/);
// Reserved: 'default' = RouterOS built-in hotspot profile; 'semua' = block engine's
// router-wide group. Turning either into an Access Profile would hijack it.
const RESERVED_PROFILE_NAMES = ['default', 'semua'];

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
function assertMemberValue(kind: 'subnet' | 'ip' | 'mac', value: string): void {
  const ok = kind === 'mac' ? MAC_RE.test(value) : kind === 'ip' ? IPV4_RE.test(value) : CIDR_RE.test(value);
  if (!ok) throw badRequest(`Format ${kind} tidak valid: "${value}"`);
}
// Allowlist destination = a domain (RouterOS auto-resolves), an IP, or a CIDR.
const DOMAIN_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
function assertAllowValue(v: string): void {
  if (!(CIDR_RE.test(v) || IPV4_RE.test(v) || DOMAIN_RE.test(v))) {
    throw badRequest(`Tujuan yang diizinkan tidak valid: "${v}"`);
  }
}

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
  const accessView = { onRequest: [authenticate], preHandler: [requirePermission('access:view')] };
  const accessManage = { onRequest: [authenticate], preHandler: [requirePermission('access:manage')] };

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
      // noc-svc-<key> holds domains (auto-resolving) + static IP ranges together;
      // createIntent adds the address-list drop + one tls-host (SNI) drop per glob.
      await c.ensureServiceDomains(svc.key, [...svc.domains, ...(svc.ipRanges ?? [])]);
      await c.createIntent({ group: body.group, service: svc.key, tlsHosts: svc.sniGlobs });
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
      if (active) {
        // Turning ON converges the set first (createIntent is idempotent), so any
        // layers missing from an older/partial intent — SNI, IP ranges, the group
        // QUIC drop — are materialized before we enable. Without this, re-enabling a
        // pre-existing domain-only intent would silently keep leaking.
        const bar = ruleId.indexOf('|');
        const group = bar >= 0 ? ruleId.slice(0, bar) : 'semua';
        const service = bar >= 0 ? ruleId.slice(bar + 1) : ruleId;
        const svc = BLOCK_SERVICES.find((s) => s.key === service);
        await c.ensureBlockChain();
        if (svc) {
          await c.ensureServiceDomains(svc.key, [...svc.domains, ...(svc.ipRanges ?? [])]);
          await c.createIntent({ group, service: svc.key, tlsHosts: svc.sniGlobs });
        }
      }
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

  // Delete a legacy forward drop/reject rule (cleanup of the old mess).
  app.delete('/:id/blocks/:ruleId', manage, async (req) => {
    const { id, ruleId } = z.object({ id: z.string(), ruleId: rosId }).parse(req.params);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.removeFilterRule(ruleId); // legacy: remove ONE rule by raw RouterOS .id
      return bak;
    });
    await writeAudit(req, {
      action: 'firewall-block-remove',
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

  // ---- Access profiles (per-profile app policy) ------------------------------
  // A profile = a hotspot user-profile bound to noc-grp-<name>; its blocklist policy
  // is enforced by the per-group block engine. Phase 1 = blocklist only.

  app.get('/:id/profiles', accessView, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listAccessProfiles());
  });

  app.post('/:id/profiles', accessManage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = accessProfileCreateSchema.parse(req.body);
    if (RESERVED_PROFILE_NAMES.includes(body.name.toLowerCase())) {
      throw badRequest(`Nama "${body.name}" dilindungi — pakai nama lain.`);
    }
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.createAccessProfile(body.name);
      return bak;
    });
    await writeAudit(req, {
      action: 'access-profile-create',
      entity: 'router',
      entityId: id,
      after: { name: body.name, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.delete('/:id/profiles/:name', accessManage, async (req) => {
    const { id, name } = z.object({ id: z.string(), name: accessName }).parse(req.params);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.deleteAccessProfile(name);
      return bak;
    });
    await writeAudit(req, {
      action: 'access-profile-delete',
      entity: 'router',
      entityId: id,
      after: { name, backup: result },
    });
    return { ok: true, backup: result };
  });

  // Set a profile's app policy. Phase 1 = blocklist: reconcile the group's service
  // intents to EXACTLY the requested set (add missing, remove dropped, enable all).
  app.post('/:id/profiles/:name/policy', accessManage, async (req) => {
    const { id, name } = z.object({ id: z.string(), name: accessName }).parse(req.params);
    const body = accessPolicySchema.parse(req.body);
    const r = await routerWithAccess(req, id);

    if (body.mode === 'allowlist') {
      // Default-deny: only local + DNS + the listed destinations reach out. The deny-all
      // is created DISABLED unless enforce=true (staged) to avoid accidental lockout.
      for (const v of body.allow) assertAllowValue(v);
      const result = await withClient(r, async (c) => {
        const bak = await backup(c);
        await c.ensureBlockChain();
        // switching to allowlist: tear down any blocklist intents for this group first
        const current = (await c.listBlockIntents()).filter((i) => i.group === name);
        for (const i of current) await c.removeIntent(`${name}|${i.service}`);
        await c.setAllowlist(name, body.allow, body.enforce ?? false);
        return bak;
      });
      await writeAudit(req, {
        action: 'access-profile-policy',
        entity: 'router',
        entityId: id,
        after: { name, mode: 'allowlist', allow: body.allow, enforce: body.enforce ?? false, backup: result },
      });
      return { ok: true, backup: result };
    }

    // blocklist: reconcile the group's service intents to EXACTLY the requested set.
    const desired = body.services;
    const unknown = desired.filter((s) => !BLOCK_SERVICES.some((b) => b.key === s));
    if (unknown.length) throw badRequest(`Layanan tidak dikenal: ${unknown.join(', ')}`);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      await c.ensureBlockChain();
      await c.removeAllowlist(name); // switching away from allowlist (no-op if none)
      const current = (await c.listBlockIntents())
        .filter((i) => i.group === name)
        .map((i) => i.service);
      for (const svc of current) {
        if (!desired.includes(svc)) await c.removeIntent(`${name}|${svc}`);
      }
      for (const key of desired) {
        const svc = BLOCK_SERVICES.find((b) => b.key === key);
        if (!svc) continue;
        await c.ensureServiceDomains(svc.key, [...svc.domains, ...(svc.ipRanges ?? [])]);
        await c.createIntent({ group: name, service: svc.key, tlsHosts: svc.sniGlobs });
        await c.setIntentActive(`${name}|${svc.key}`, true);
      }
      return bak;
    });
    await writeAudit(req, {
      action: 'access-profile-policy',
      entity: 'router',
      entityId: id,
      after: { name, mode: 'blocklist', services: desired, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.get('/:id/profiles/:name/members', accessView, async (req) => {
    const { id, name } = z.object({ id: z.string(), name: accessName }).parse(req.params);
    const r = await routerWithAccess(req, id);
    return withClient(r, (c) => c.listGroupMembers(name));
  });

  app.post('/:id/profiles/:name/members', accessManage, async (req) => {
    const { id, name } = z.object({ id: z.string(), name: accessName }).parse(req.params);
    const body = accessMemberSchema.parse(req.body);
    assertMemberValue(body.kind, body.value);
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      if (body.kind === 'mac') await c.addGroupMac(name, body.value);
      else await c.addAddressListEntry({ list: `noc-grp-${name}`, address: body.value, comment: `NOC-MEM:${name}` });
      return bak;
    });
    await writeAudit(req, {
      action: 'access-member-add',
      entity: 'router',
      entityId: id,
      after: { name, kind: body.kind, value: body.value, backup: result },
    });
    return { ok: true, backup: result };
  });

  app.delete('/:id/profiles/:name/members', accessManage, async (req) => {
    const { id, name } = z.object({ id: z.string(), name: accessName }).parse(req.params);
    const body = accessMemberSchema.parse(req.query); // DELETE has no body (api.del) → query
    const r = await routerWithAccess(req, id);
    const result = await withClient(r, async (c) => {
      const bak = await backup(c);
      if (body.kind === 'mac') {
        await c.removeGroupMac(name, body.value);
      } else {
        const m = (await c.listGroupMembers(name)).find(
          (x) => x.source === 'static' && x.value === body.value,
        );
        if (m) await c.removeAddressListEntry(m.id);
      }
      return bak;
    });
    await writeAudit(req, {
      action: 'access-member-remove',
      entity: 'router',
      entityId: id,
      after: { name, kind: body.kind, value: body.value, backup: result },
    });
    return { ok: true, backup: result };
  });
}
