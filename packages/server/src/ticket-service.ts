// =============================================================================
// Shared ticket creation — used by BOTH the WhatsApp bot intake AND the
// member web endpoint (/me/tickets). One implementation keeps the forwarded
// message format and recipient targeting identical across channels.
// =============================================================================

import type { PrismaClient, Ticket } from '@prisma/client';
import type { TicketCategory } from '@noc/shared';
import { enqueueWaMessage } from './wa';
import type { Redis } from './redis';

/** Human code shown in forwards and accepted in PROSES/SELESAI. */
export const ticketCode = (t: { id: string }) => t.id.slice(0, 6).toUpperCase();

export interface CreateTicketInput {
  siteId: string;
  /** Reporter's WA digits when reachable; null for web-only members. */
  reporterPhone?: string | null;
  reporterName?: string | null;
  /** Department snapshot (free text) shown on the tickets page. */
  reporterDept?: string | null;
  category?: TicketCategory;
  message: string;
  memberId?: string | null;
}

/**
 * Insert the ticket, then forward it to every tickets-enabled recipient of the
 * site (numbers AND groups). Returns the created row.
 */
export async function createAndForwardTicket(
  deps: { prisma: PrismaClient; redis: Redis },
  input: CreateTicketInput,
): Promise<Ticket> {
  const t = await deps.prisma.ticket.create({
    data: {
      siteId: input.siteId,
      memberId: input.memberId ?? null,
      reporterPhone: input.reporterPhone ?? null,
      reporterName: input.reporterName ?? null,
      reporterDept: input.reporterDept ?? null,
      category: input.category ?? 'gangguan',
      message: input.message,
    },
  });

  const site = await deps.prisma.site.findUnique({
    where: { id: input.siteId },
    include: { waRecipients: { where: { isActive: true, tickets: true } } },
  });
  const member = input.memberId
    ? await deps.prisma.appUser.findUnique({
        where: { id: input.memberId },
        select: { name: true, hotspotUsername: true },
      })
    : null;

  const code = ticketCode(t);
  const text = [
    `🎫 *TIKET BARU #${code}*`,
    '──────────────────',
    `🏭 Site    : *${site?.name ?? input.siteId}*`,
    `👤 Pelapor : ${input.reporterName ?? 'Anonim'}` +
      (input.reporterDept ? ` · ${input.reporterDept}` : ''),
    `📱 Kontak  : ${input.reporterPhone ?? 'via web'}` +
      (member?.hotspotUsername ? ` · akun ${member.hotspotUsername}` : ''),
    `💬 Isi     : "${input.message.slice(0, 500)}"`,
    '──────────────────',
    `_Balas: *PROSES ${code}* (ambil alih)_`,
    `_        *SELESAI ${code}* (tutup tiket)_`,
  ].join('\n');

  const targets = new Set<string>();
  for (const c of site?.waRecipients ?? []) targets.add(c.target);
  for (const to of targets) {
    await enqueueWaMessage(deps, { to, text, kind: 'ticket-forward', siteId: input.siteId });
  }
  return t;
}

/** Notify the reporter of a status change — skipped when they have no phone. */
export async function notifyReporter(
  deps: { prisma: PrismaClient; redis: Redis },
  t: Ticket,
  status: 'ack' | 'resolved',
): Promise<void> {
  if (!t.reporterPhone) return;
  await enqueueWaMessage(deps, {
    to: t.reporterPhone,
    text: [
      status === 'resolved' ? '✅ *Tiket Anda SELESAI*' : '🔧 *Tiket Anda Diproses*',
      '──────────────────',
      `Tiket *#${ticketCode(t)}* ${status === 'resolved' ? 'sudah selesai ditangani teknisi.' : 'sedang dikerjakan teknisi.'}`,
      '──────────────────',
      '_Terima kasih atas laporannya_',
    ].join('\n'),
    kind: 'reply',
    siteId: t.siteId,
  });
}
