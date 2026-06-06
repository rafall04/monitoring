// =============================================================================
// Retention sweeper. Reads eventRetentionDays + auditRetentionDays from the
// global Setting once per hour and prunes rows older than that cutoff. Without
// this the DB grows forever because every poll writes status events.
//
// Deletes are batched so the sweep can't block the rest of the worker on a
// huge backlog (e.g. the first run after enabling retention on a year-old DB).
// =============================================================================

import { getSettings, prisma, type Logger } from '@noc/server';

const HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 5_000;

export interface RetentionStats {
  lastRunAt: number;
  lastEventsDeleted: number;
  lastAuditDeleted: number;
}

export class RetentionSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  public stats: RetentionStats = { lastRunAt: 0, lastEventsDeleted: 0, lastAuditDeleted: 0 };

  constructor(private readonly logger: Logger) {}

  start(): void {
    // Run once shortly after start, then every hour.
    setTimeout(() => void this.run(), 30_000).unref?.();
    this.timer = setInterval(() => void this.run(), HOUR_MS);
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
      const eventsDeleted = await this.purgeOlderThan('statusEvent', s.eventRetentionDays);
      const auditDeleted = await this.purgeOlderThan('auditLog', s.auditRetentionDays);

      this.stats = {
        lastRunAt: Date.now(),
        lastEventsDeleted: eventsDeleted,
        lastAuditDeleted: auditDeleted,
      };
      this.logger.info(
        {
          eventsDeleted,
          auditDeleted,
          eventRetentionDays: s.eventRetentionDays,
          auditRetentionDays: s.auditRetentionDays,
        },
        'retention sweep complete',
      );
    } catch (err) {
      this.logger.warn({ err: (err as Error)?.message }, 'retention sweep failed');
    } finally {
      this.running = false;
    }
  }

  /** Delete rows where createdAt < (now - days). Batched. */
  private async purgeOlderThan(
    table: 'statusEvent' | 'auditLog',
    days: number,
  ): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * HOUR_MS);
    let totalDeleted = 0;
    // Loop until we did less than a full batch — protects against running for
    // an unbounded time on first run with a huge backlog.
    for (let safety = 0; safety < 200; safety++) {
      // StatusEvent's timestamp column is `occurredAt`; AuditLog's is `createdAt`.
      const where =
        table === 'statusEvent'
          ? { occurredAt: { lt: cutoff } }
          : { createdAt: { lt: cutoff } };

      const ids = await (table === 'statusEvent'
        ? prisma.statusEvent.findMany({ where, select: { id: true }, take: BATCH_SIZE })
        : prisma.auditLog.findMany({ where, select: { id: true }, take: BATCH_SIZE }));

      if (ids.length === 0) break;
      const idList = ids.map((r) => r.id);
      const res =
        table === 'statusEvent'
          ? await prisma.statusEvent.deleteMany({ where: { id: { in: idList } } })
          : await prisma.auditLog.deleteMany({ where: { id: { in: idList } } });
      totalDeleted += res.count;
      if (ids.length < BATCH_SIZE) break;
    }
    return totalDeleted;
  }
}
