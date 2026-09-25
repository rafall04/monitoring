// =============================================================================
// Ticket escalator. Every minute, find tickets still `open` after
// Setting.waTicketEscalateMin and ping the site's manager contacts over
// WhatsApp. `escalatedAt` marks the escalation so it fires exactly once.
// Runs on the primary shard only — escalation is a singleton duty.
// =============================================================================

import {
  enqueueWaMessage,
  getSettings,
  prisma,
  type Logger,
  type Redis,
} from '@noc/server';

const SWEEP_MS = 60_000;

export interface EscalatorStats {
  lastRunAt: number;
  escalated: number;
}

export class TicketEscalator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  public stats: EscalatorStats = { lastRunAt: 0, escalated: 0 };

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  start(): void {
    setTimeout(() => void this.run(), 60_000).unref?.();
    this.timer = setInterval(() => void this.run(), SWEEP_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = await getSettings();
      if (s.waTicketEscalateMin <= 0) return; // escalation disabled
      const cutoff = new Date(Date.now() - s.waTicketEscalateMin * 60_000);
      const stale = await prisma.ticket.findMany({
        where: { status: 'open', escalatedAt: null, createdAt: { lt: cutoff } },
        include: {
          site: {
            include: {
              waRecipients: {
                where: {
                  isActive: true,
                  OR: [{ role: 'manager' }, { kind: 'group' }],
                },
              },
            },
          },
        },
        take: 50,
      });
      let escalated = 0;
      for (const t of stale) {
        // Claim first — if two shards ever race, escalatedAt makes it idempotent.
        const claim = await prisma.ticket.updateMany({
          where: { id: t.id, escalatedAt: null },
          data: { escalatedAt: new Date() },
        });
        if (claim.count === 0) continue;
        const code = t.id.slice(0, 6).toUpperCase();
        const text = [
          `🚨 *ESKALASI TIKET #${code}* — belum diproses > ${s.waTicketEscalateMin} mnt`,
          `🏭 ${t.site.name}`,
          `👤 ${t.reporterName ?? 'Anonim'} · ${t.reporterPhone}`,
          `💬 "${t.message.slice(0, 300)}"`,
          '',
          `Balas: *PROSES ${code}* / *SELESAI ${code}*`,
        ].join('\n');
        const targets = new Set<string>();
        for (const c of t.site.waRecipients) targets.add(c.target);
        for (const to of targets) {
          await enqueueWaMessage(
            { prisma, redis: this.redis },
            { to, text, kind: 'ticket-forward', siteId: t.siteId },
          );
        }
        escalated++;
      }
      this.stats = { lastRunAt: Date.now(), escalated };
      if (escalated) this.logger.info({ escalated }, 'ticket escalation sweep');
    } catch (err) {
      this.logger.warn({ err: (err as Error)?.message }, 'ticket escalation failed');
    } finally {
      this.running = false;
    }
  }
}
