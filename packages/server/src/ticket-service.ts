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
): Promise<{ t: Ticket; targets: number }> {
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
  const when = new Date(t.createdAt).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const text = [
    `🎫 *TIKET BARU #${code}*`,
    '──────────────────',
    `🏭 Site       : *${site?.name ?? input.siteId}*`,
    `👤 Pelapor    : *${input.reporterName ?? 'Anonim'}*`,
    `🏢 Departemen : ${input.reporterDept ?? '-'}`,
    `📱 Kontak     : ${input.reporterPhone ?? 'via web'}`,
    member?.hotspotUsername ? `🔑 Akun       : ${member.hotspotUsername}` : null,
    `� Waktu      : ${when} WIB`,
    '──────────────────',
    `💬 *Keluhan:*`,
    `"${input.message.slice(0, 500)}"`,
    '──────────────────',
    `📌 Status: *OPEN*`,
    `_Balas *PROSES ${code}* untuk ambil alih_`,
    `_Balas *SELESAI ${code}* untuk menutup_`,
  ].filter(Boolean).join('\n');

  const targets = new Set<string>();
  for (const c of site?.waRecipients ?? []) targets.add(c.target);
  for (const to of targets) {
    await enqueueWaMessage(deps, { to, text, kind: 'ticket-forward', siteId: input.siteId });
  }
  return { t, targets: targets.size };
}

/** Notify the reporter of a status change — skipped when they have no phone. */
export async function notifyReporter(
  deps: { prisma: PrismaClient; redis: Redis },
  t: Ticket,
  status: 'ack' | 'resolved',
  note?: string,
): Promise<void> {
  if (!t.reporterPhone) return;
  await enqueueWaMessage(deps, {
    to: t.reporterPhone,
    text: [
      status === 'resolved' ? '✅ *Tiket Anda SELESAI*' : '🔧 *Tiket Anda Diproses*',
      '──────────────────',
      `Tiket    : *#${ticketCode(t)}*`,
      `Keluhan  : "${t.message.slice(0, 200)}"`,
      `Status   : ${status === 'resolved' ? '*SELESAI* — sudah ditangani teknisi' : '*DIPROSES* — sedang dikerjakan'}`,
      t.handledBy ? `Teknisi  : ${t.handledBy}` : null,
      note ? `Catatan  : ${note.slice(0, 200)}` : null,
      '──────────────────',
      '_Terima kasih atas laporannya_',
    ].filter(Boolean).join('\n'),
    kind: 'reply',
    siteId: t.siteId,
  });
}
