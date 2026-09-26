import type { FastifyInstance } from 'fastify';
import {
  createAndForwardTicket,
  createWaLinkCode,
  prisma,
  sha256,
  toTicketDto,
} from '@noc/server';
import { memberTicketSchema, refreshSchema } from '@noc/shared';
import { badRequest, notFound, unauthorized } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate } from '../plugins/auth';

/**
 * /me endpoints that apply to EVERY logged-in user (member AND staff):
 * WhatsApp phone linking. The user requests a one-time code here, then texts
 * `LINK <code>` to the bot — proving ownership of that number. Verified numbers
 * unlock the bot's member/staff commands.
 *
 * /me/tickets is the member's web twin of the bot's KOMPLAIN command — the
 * member files and tracks their own complaints. Site + reporter identity come
 * from the account, never the request body.
 */
export async function meRoutes(app: FastifyInstance) {
  const guard = { onRequest: [authenticate] };

  app.get('/wa', guard, async (req) => {
    const me = await prisma.appUser.findUnique({ where: { id: req.appUser.id } });
    return {
      phone: me?.phone ?? null,
      phoneVerified: me?.phoneVerifiedAt != null,
    };
  });

  app.post(
    '/wa/link-code',
    { ...guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => createWaLinkCode(app.redisPub, req.appUser.id),
  );

  // ---- Login sessions -------------------------------------------------------
  // Each live refresh token = one signed-in device/browser. No user-agent is
  // stored (privacy + schema simplicity), so rows are identified by time.
  // Every query is pinned to req.appUser.id — a session row can never be
  // touched by anyone but its owner.

  app.get('/sessions', guard, async (req) => {
    const rows = await prisma.refreshToken.findMany({
      where: { userId: req.appUser.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, expiresAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  });

  // Revoke one session by id — revoking the current device's session simply
  // logs that device out at the next token refresh.
  app.delete('/sessions/:id', guard, async (req) => {
    const { id } = req.params as { id: string };
    const res = await prisma.refreshToken.updateMany({
      where: { id, userId: req.appUser.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw notFound('Sesi tidak ditemukan');
    await writeAudit(req, {
      action: 'session-revoke',
      entity: 'app_user',
      entityId: req.appUser.id,
      after: { sessionId: id },
    });
    return { revoked: true };
  });

  // "Keluar dari semua perangkat lain" — the client proves which session to
  // KEEP by posting its own refresh token (same keepHash pattern as
  // /auth/change-password). Never revokes the caller's current session.
  app.post(
    '/sessions/revoke-others',
    { ...guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const { refreshToken } = refreshSchema.parse(req.body);
      const res = await prisma.refreshToken.updateMany({
        where: {
          userId: req.appUser.id,
          revokedAt: null,
          tokenHash: { not: sha256(refreshToken) },
        },
        data: { revokedAt: new Date() },
      });
      await writeAudit(req, {
        action: 'session-revoke-others',
        entity: 'app_user',
        entityId: req.appUser.id,
        after: { count: res.count },
      });
      return { revoked: res.count };
    },
  );

  // ---- Member complaints ----------------------------------------------------

  app.get('/tickets', guard, async (req) => {
    const rows = await prisma.ticket.findMany({
      where: { memberId: req.appUser.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { site: { select: { name: true } } },
    });
    return rows.map(toTicketDto);
  });

  app.post(
    '/tickets',
    { ...guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const body = memberTicketSchema.parse(req.body);
      const me = await prisma.appUser.findUnique({ where: { id: req.appUser.id } });
      if (!me || !me.isActive) throw unauthorized();
      if (!me.hotspotRouterId)
        throw badRequest('Akun belum tertaut ke hotspot — hubungi IT Support.');
      const router = await prisma.routerMikrotik.findUnique({
        where: { id: me.hotspotRouterId },
      });
      if (!router) throw badRequest('Router hotspot tidak ditemukan — hubungi IT Support.');

      const dept = body.department?.trim() || me.department;
      // First-time department from the form is kept on the profile (same as
      // the bot asking once). null/empty body leaves the profile untouched.
      if (dept && dept !== me.department) {
        await prisma.appUser.update({
          where: { id: me.id },
          data: { department: dept },
        });
      }

      const { t } = await createAndForwardTicket(
        { prisma, redis: app.redisPub },
        {
          siteId: router.siteId,
          reporterPhone: me.phone ?? null,
          reporterName: me.name,
          reporterDept: dept,
          category: body.category,
          message: body.message,
          memberId: me.id,
        },
      );
      await writeAudit(req, {
        action: 'ticket-create',
        entity: 'ticket',
        entityId: t.id,
        after: { via: 'web', siteId: router.siteId, dept },
      });
      const full = await prisma.ticket.findUniqueOrThrow({
        where: { id: t.id },
        include: { site: { select: { name: true } }, member: { select: { name: true } } },
      });
      return toTicketDto(full);
    },
  );
}
