import type { FastifyInstance } from 'fastify';
import {
  createAndForwardTicket,
  createWaLinkCode,
  prisma,
  toTicketDto,
} from '@noc/server';
import { memberTicketSchema } from '@noc/shared';
import { badRequest, unauthorized } from '../lib/errors';
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

      const t = await createAndForwardTicket(
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
