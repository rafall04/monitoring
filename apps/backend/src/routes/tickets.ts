import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@noc/server';
import { enqueueWaMessage, prisma, toTicketDto } from '@noc/server';
import { idParamSchema, ticketQuerySchema, updateTicketSchema } from '@noc/shared';
import { notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission, siteScopeWhere } from '../plugins/rbac';

/**
 * Complaint tickets — created by the WhatsApp bot (member `komplain` or the
 * anonymous intake), worked by operators here or by technicians replying
 * PROSES/SELESAI to the bot. Site-scoped like every other list.
 */
export async function ticketRoutes(app: FastifyInstance) {
  const view = { onRequest: [authenticate], preHandler: [requirePermission('tickets:view')] };
  const manage = { onRequest: [authenticate], preHandler: [requirePermission('tickets:manage')] };
  const include = {
    site: { select: { name: true } },
    member: { select: { name: true } },
  } as const;

  app.get('/', view, async (req) => {
    const q = ticketQuerySchema.parse(req.query ?? {});
    const where: Prisma.TicketWhereInput = { ...siteScopeWhere(req.appUser) };
    if (q.siteId) {
      assertSiteAccess(req.appUser, q.siteId);
      where.siteId = q.siteId;
    }
    if (q.status) where.status = q.status;
    const rows = await prisma.ticket.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return rows.map(toTicketDto);
  });

  app.patch('/:id', manage, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateTicketSchema.parse(req.body);
    const t = await prisma.ticket.findUnique({ where: { id } });
    if (!t) throw notFound('Ticket not found');
    assertSiteAccess(req.appUser, t.siteId);

    const actor = req.appUser.name || req.appUser.email;
    const u = await prisma.ticket.update({
      where: { id },
      data: {
        ...(body.status
          ? {
              status: body.status,
              resolvedAt: body.status === 'resolved' ? new Date() : null,
              handledBy: body.handledBy ?? actor,
            }
          : {}),
        ...(!body.status && body.handledBy !== undefined ? { handledBy: body.handledBy } : {}),
      },
      include,
    });
    await writeAudit(req, {
      action: 'ticket-update',
      entity: 'ticket',
      entityId: id,
      before: { status: t.status },
      after: { status: u.status, handledBy: u.handledBy },
    });

    // Close the loop back to the reporter over WhatsApp (best-effort).
    // reporterPhone is null for web complaints from unlinked members — the
    // status then lives in their /me/tickets history only.
    if (body.status && body.status !== t.status && u.reporterPhone) {
      const label =
        body.status === 'resolved' ? 'sudah SELESAI ✅' : 'sedang DIPROSES 🔧';
      await enqueueWaMessage(
        { prisma, redis: app.redisPub },
        {
          to: u.reporterPhone,
          text: `Tiket #${u.id.slice(0, 6)} Anda ${label}.\n"${u.message.slice(0, 120)}"`,
          kind: 'reply',
          siteId: u.siteId,
        },
      ).catch((err) => req.log.warn({ err }, 'ticket reporter notify failed'));
    }
    return toTicketDto(u);
  });
}
