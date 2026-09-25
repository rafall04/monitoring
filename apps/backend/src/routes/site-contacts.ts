import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma, toWaRecipientDto } from '@noc/server';
import { idParamSchema, waRecipientUpsertSchema } from '@noc/shared';
import { notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { assertSiteAccess, authenticate, requirePermission } from '../plugins/rbac';

const recipientParams = idParamSchema.extend({ recipientId: z.string().min(1) });

/**
 * Per-site WhatsApp recipients — the numbers AND groups the bot alerts and
 * forwards tickets to (wa_recipient). Managed from the admin WhatsApp page;
 * kept under /sites so the siteId rides the URL. Recipients are site
 * configuration, so they share the site:manage gate.
 */
export async function siteContactRoutes(app: FastifyInstance) {
  const guard = { onRequest: [authenticate], preHandler: [requirePermission('site:manage')] };

  app.get('/:id/recipients', guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const rows = await prisma.waRecipient.findMany({
      where: { siteId: id },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toWaRecipientDto);
  });

  // Upsert: body.id present → update, absent → create.
  app.post('/:id/recipients', guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const { id: recipientId, ...body } = waRecipientUpsertSchema.parse(req.body);
    let row;
    if (recipientId) {
      const existing = await prisma.waRecipient.findFirst({
        where: { id: recipientId, siteId: id },
      });
      if (!existing) throw notFound('Recipient not found');
      row = await prisma.waRecipient.update({ where: { id: recipientId }, data: body });
    } else {
      row = await prisma.waRecipient.create({ data: { ...body, siteId: id } });
    }
    await writeAudit(req, {
      action: recipientId ? 'wa-recipient-update' : 'wa-recipient-create',
      entity: 'wa_recipient',
      entityId: row.id,
      after: { siteId: id, target: row.target, kind: row.kind, name: row.name },
    });
    return toWaRecipientDto(row);
  });

  app.delete('/:id/recipients/:recipientId', guard, async (req, reply) => {
    const { id, recipientId } = recipientParams.parse(req.params);
    assertSiteAccess(req.appUser, id);
    const existing = await prisma.waRecipient.findFirst({
      where: { id: recipientId, siteId: id },
    });
    if (!existing) throw notFound('Recipient not found');
    await prisma.waRecipient.delete({ where: { id: recipientId } });
    await writeAudit(req, {
      action: 'wa-recipient-delete',
      entity: 'wa_recipient',
      entityId: recipientId,
      before: { siteId: id, target: existing.target, kind: existing.kind, name: existing.name },
    });
    reply.code(204);
    return null;
  });
}
