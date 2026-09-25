// =============================================================================
// Ticket operations for the bot: technician reply commands (PROSES / SELESAI).
// Ticket creation + forwarding lives in @noc/server ticket-service — shared
// verbatim with the web endpoint (/me/tickets).
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { canAccessSite, normalizePhone, type Role } from '@noc/shared';
import {
  createAndForwardTicket,
  notifyReporter,
  ticketCode,
  type Redis,
} from '@noc/server';

export { createAndForwardTicket, ticketCode };

export interface BotCtx {
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger;
  reply: (to: string, text: string) => Promise<void>;
}

/**
 * `PROSES <code>` / `SELESAI <code>` from a technician. Authorization: the
 * sender's number is a WaRecipient (kind='number') of the ticket's site, or a
 * verified staff AppUser whose scope covers it.
 */
export async function handleTicketCommand(
  ctx: BotCtx,
  from: string,
  action: 'proses' | 'selesai',
  code: string,
): Promise<void> {
  const matches = await ctx.prisma.ticket.findMany({
    where: { id: { startsWith: code.toLowerCase() }, status: { not: 'resolved' } },
    take: 5,
  });
  if (matches.length === 0) {
    await ctx.reply(from, `Tiket #${code.toUpperCase()} tidak ditemukan / sudah selesai.`);
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(from, `Kode ${code.toUpperCase()} ambigu — pakai kode tiket lebih panjang.`);
    return;
  }
  const t = matches[0]!;

  const phone = normalizePhone(from);
  const contact = await ctx.prisma.waRecipient.findFirst({
    where: { siteId: t.siteId, target: phone, kind: 'number', isActive: true },
  });
  const staff = await ctx.prisma.appUser.findFirst({
    where: { phone, phoneVerifiedAt: { not: null }, isActive: true, role: { not: 'member' } },
  });
  const staffAllowed =
    staff &&
    canAccessSite(
      { role: staff.role as Role, scopeSiteIds: (staff.scopeSiteIds as string[]) ?? [] },
      t.siteId,
    );
  if (!contact && !staffAllowed) {
    await ctx.reply(from, 'Nomor Anda tidak terdaftar sebagai teknisi untuk site tiket ini.');
    return;
  }

  const actor = contact?.name ?? staff?.name ?? phone;
  const status = action === 'proses' ? 'ack' : 'resolved';
  const u = await ctx.prisma.ticket.update({
    where: { id: t.id },
    data: {
      status,
      handledBy: actor,
      ...(status === 'resolved' ? { resolvedAt: new Date() } : {}),
    },
  });
  await ctx.prisma.auditLog
    .create({
      data: {
        userId: staff?.id ?? null,
        action: `ticket-${action}`,
        entity: 'ticket',
        entityId: t.id,
        after: { status, via: 'whatsapp', actor },
      },
    })
    .catch(() => undefined);

  await ctx.reply(
    from,
    `✅ Tiket #${ticketCode(u)} ${action === 'proses' ? 'ditandai DIPROSES' : 'SELESAI'} oleh ${actor}.`,
  );
  // Close the loop to the reporter — skipped when they reported via web
  // without a linked WA number (status then lives in their portal history).
  await notifyReporter({ prisma: ctx.prisma, redis: ctx.redis }, u, status);
}
