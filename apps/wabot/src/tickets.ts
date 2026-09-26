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
import { DIV, ago, card, kvBlock } from './fmt';

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
 * verified staff AppUser whose scope covers it. `replyTo` differs from `from`
 * only for group commands (reply goes back to the group JID).
 */
export async function handleTicketCommand(
  ctx: BotCtx,
  from: string,
  replyTo: string,
  action: 'proses' | 'selesai',
  code: string,
  note?: string,
): Promise<void> {
  const matches = await ctx.prisma.ticket.findMany({
    where: { id: { startsWith: code.toLowerCase() }, status: { not: 'resolved' } },
    include: { site: { select: { name: true } } },
    take: 5,
  });
  if (matches.length === 0) {
    await ctx.reply(
      replyTo,
      card(
        '❓ *Tiket tidak ada*',
        `Tiket *#${code.toUpperCase()}* tidak ditemukan atau sudah selesai.`,
        'Ketik TIKET untuk daftar tiket terbuka',
      ),
    );
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(
      replyTo,
      card(
        '🔍 *Kode ambigu*',
        `Kode *${code.toUpperCase()}* cocok dengan *${matches.length}* tiket:\n${matches
          .map((m) => `· *#${ticketCode(m)}* — ${m.site.name} · "${m.message.slice(0, 40)}"`)
          .join('\n')}`,
        'Pakai kode lebih panjang (mis. 8 huruf)',
      ),
    );
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
    await ctx.reply(
      replyTo,
      card(
        '⛔ *Bukan teknisi*',
        `Nomor Anda tidak terdaftar sebagai teknisi untuk site *${t.site.name}* (tiket #${ticketCode(t)}).`,
        'Minta admin menambahkan nomor Anda ke penerima site',
      ),
    );
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
        after: { status, via: 'whatsapp', actor, ...(note ? { note } : {}) },
      },
    })
    .catch(() => undefined);

  // Confirmation carries the ticket's key facts — in a group the card tells
  // everyone WHAT was closed without scrolling back to the forward.
  await ctx.reply(
    replyTo,
    card(
      action === 'proses' ? '🔧 *Tiket Diproses*' : '✅ *Tiket Selesai*',
      [
        ...kvBlock([
          ['Tiket', `*#${ticketCode(u)}* — ${t.site.name}`],
          ['Pelapor', `${t.reporterName ?? 'Anonim'}${t.reporterDept ? ` · ${t.reporterDept}` : ''}`],
          ['Keluhan', `"${t.message.slice(0, 120)}"`],
          ['Oleh', actor],
          ['Durasi', `${ago(t.createdAt.toISOString())} sejak dilaporkan`],
          ['Catatan', note?.slice(0, 200)],
        ]),
        DIV,
        action === 'proses' ? '_Balas SELESAI ke pesan ini untuk menutup_' : '_Pelapor sudah dikabari otomatis_',
      ],
    ),
  );
  // Close the loop to the reporter — skipped when they reported via web
  // without a linked WA number (status then lives in their portal history).
  await notifyReporter({ prisma: ctx.prisma, redis: ctx.redis }, u, status, note);
}
