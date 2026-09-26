import type { FastifyInstance } from 'fastify';
import { enqueueWaMessage, prisma, readWaGroups, readWaSession } from '@noc/server';
import {
  REDIS_KEYS,
  waBroadcastSchema,
  waTestMessageSchema,
  type WaControlMessage,
  type WaControlOp,
  type WaSessionState,
} from '@noc/shared';
import { badRequest, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission } from '../plugins/rbac';

const OFFLINE: WaSessionState = {
  status: 'offline',
  qr: null,
  phone: null,
  name: null,
  error: null,
  updatedAt: new Date(0).toISOString(),
};

/**
 * WhatsApp bot control surface. The socket itself lives in apps/wabot — these
 * endpoints only read the session snapshot it publishes to Redis (pairing UI),
 * enqueue onto the outbox (test/broadcast), and LPUSH control ops (session
 * lifecycle). Gated to whatsapp:manage (super_admin): the bot IS the org's
 * WhatsApp identity.
 */
export async function whatsappRoutes(app: FastifyInstance) {
  const guard = { onRequest: [authenticate], preHandler: [requirePermission('whatsapp:manage')] };

  app.get('/session', guard, async () => {
    return (await readWaSession(app.redisPub)) ?? OFFLINE;
  });

  // Session lifecycle: enqueue a control op for wabot (BLPOP on its side, so
  // the command is not lost while the bot is mid-restart).
  const control = (op: WaControlOp) =>
    app.post(`/${op}`, guard, async (req) => {
      const msg: WaControlMessage = { op, requestedBy: req.appUser.email };
      await app.redisPub.lpush(REDIS_KEYS.waControl, JSON.stringify(msg));
      await writeAudit(req, {
        action: `wa-${op}`,
        entity: 'wa_session',
        entityId: 'bot',
        after: { requestedBy: req.appUser.email },
      });
      return { queued: true };
    });
  control('reconnect'); // soft restart — keeps paired keys
  control('logout');    // unlinks the device + wipes keys → fresh QR

  // Groups the bot participates in — the pick-list for kind='group'
  // recipients. Wabot refreshes the cache on connect + group events; the
  // refresh endpoint just queues a manual re-fetch (same control channel).
  app.get('/groups', guard, async () => readWaGroups(app.redisPub));
  app.post('/groups/refresh', guard, async (req) => {
    const msg: WaControlMessage = { op: 'groups-refresh', requestedBy: req.appUser.email };
    await app.redisPub.lpush(REDIS_KEYS.waControl, JSON.stringify(msg));
    return { queued: true };
  });

  // Send a free-form test message — verifies the outbox → socket path on demand.
  app.post('/test', guard, async (req) => {
    const body = waTestMessageSchema.parse(req.body);
    const id = await enqueueWaMessage(
      { prisma, redis: app.redisPub },
      { to: body.to, text: body.text, kind: 'test' },
    );
    await writeAudit(req, {
      action: 'wa-test-send',
      entity: 'wa_message',
      entityId: id,
      after: { to: body.to },
    });
    return { id };
  });

  // ---- Delivery log ---------------------------------------------------------
  // Recent outbound rows — the "did that alert actually send?" answer without
  // SSH. Filterable by status so the dead-letter queue is one click away.
  app.get('/messages', guard, async (req) => {
    const q = req.query as { status?: string; take?: string };
    const take = Math.min(200, Math.max(1, Number(q.take) || 50));
    const rows = await prisma.waMessage.findMany({
      where:
        q.status === 'queued' || q.status === 'sent' || q.status === 'failed' || q.status === 'dead'
          ? { status: q.status }
          : {},
      orderBy: { createdAt: 'desc' },
      take,
    });
    // siteId is a bare field (no relation) — resolve names in one extra query.
    const siteIds = [...new Set(rows.map((r) => r.siteId).filter((x): x is string => !!x))];
    const sites = siteIds.length
      ? await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } })
      : [];
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    return rows.map((r) => ({
      id: r.id,
      to: r.to,
      kind: r.kind,
      status: r.status,
      attempts: r.attempts,
      body: r.body,
      siteName: r.siteId ? (siteName.get(r.siteId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  });

  // Requeue a dead-letter row — same payload shape the producer pushed. Only
  // 'dead' is retryable: queued/failed are already in the retry loop.
  app.post('/messages/:id/retry', guard, async (req) => {
    const { id } = req.params as { id: string };
    const m = await prisma.waMessage.findUnique({ where: { id } });
    if (!m) throw notFound('Pesan tidak ditemukan');
    if (m.status !== 'dead') {
      throw badRequest(`Pesan status '${m.status}' tidak perlu di-antrekan ulang`);
    }
    await prisma.waMessage.update({
      where: { id },
      data: { status: 'queued', attempts: 0 },
    });
    await app.redisPub.lpush(
      REDIS_KEYS.waOutbox,
      JSON.stringify({ id: m.id, to: m.to, text: m.body, kind: m.kind, siteId: m.siteId }),
    );
    await writeAudit(req, {
      action: 'wa-retry',
      entity: 'wa_message',
      entityId: id,
      after: { to: m.to },
    });
    return { queued: true };
  });

  // Broadcast an announcement to a site's active recipients + every member
  // whose hotspot router lives at that site AND has a verified WhatsApp number.
  app.post('/broadcast', guard, async (req) => {
    const body = waBroadcastSchema.parse(req.body);
    assertSiteAccess(req.appUser, body.siteId);
    const site = await prisma.site.findUnique({
      where: { id: body.siteId },
      include: { waRecipients: { where: { isActive: true } } },
    });
    if (!site) throw notFound('Site not found');

    const members = await prisma.appUser.findMany({
      where: {
        isActive: true,
        phone: { not: null },
        phoneVerifiedAt: { not: null },
        hotspotRouter: { siteId: body.siteId },
      },
      select: { phone: true },
    });
    const targets = new Set<string>();
    for (const c of site.waRecipients) targets.add(c.target);
    for (const m of members) if (m.phone) targets.add(m.phone);

    for (const to of targets) {
      await enqueueWaMessage(
        { prisma, redis: app.redisPub },
        { to, text: body.text, kind: 'broadcast', siteId: site.id },
      );
    }
    await writeAudit(req, {
      action: 'wa-broadcast',
      entity: 'site',
      entityId: site.id,
      after: { targets: targets.size },
    });
    return { queued: targets.size };
  });
}
