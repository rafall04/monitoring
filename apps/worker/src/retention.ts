// =============================================================================
// Retention sweeper. Reads eventRetentionDays + auditRetentionDays from the
// global Setting once per hour and prunes rows older than that cutoff. Without
// this the DB grows forever because every poll writes status events.
//
// Deletes run through deleteInBatches (~500 rows per statement + a pause) so
// the sweep can't pin a table lock on a huge backlog (e.g. the first run
// after enabling retention on a year-old DB).
// =============================================================================

import { deleteInBatches, getSettings, prisma, type Logger } from '@noc/server';

const HOUR_MS = 60 * 60 * 1000;

export interface RetentionStats {
  lastRunAt: number;
  lastEventsDeleted: number;
  lastAuditDeleted: number;
  lastRefreshTokensDeleted: number;
}

export class RetentionSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  public stats: RetentionStats = {
    lastRunAt: 0,
    lastEventsDeleted: 0,
    lastAuditDeleted: 0,
    lastRefreshTokensDeleted: 0,
  };

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
      // Ruijie port-event timeline shares the status-event retention window.
      await this.purgeOlderThan('ruijiePortEvent', s.eventRetentionDays);
      // Expired refresh tokens are dead weight — purge by expiresAt, not age.
      const refreshTokensDeleted = await this.purgeExpiredRefreshTokens();

      this.stats = {
        lastRunAt: Date.now(),
        lastEventsDeleted: eventsDeleted,
        lastAuditDeleted: auditDeleted,
        lastRefreshTokensDeleted: refreshTokensDeleted,
      };
      this.logger.info(
        {
          eventsDeleted,
          auditDeleted,
          refreshTokensDeleted,
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

  /** Delete rows older than (now - days). Batched via deleteInBatches. */
  private async purgeOlderThan(
    table: 'statusEvent' | 'auditLog' | 'ruijiePortEvent',
    days: number,
  ): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * HOUR_MS);
    // Timestamp column differs per table: StatusEvent=occurredAt,
    // AuditLog=createdAt, RuijiePortEvent=at.
    if (table === 'statusEvent') {
      return deleteInBatches(
        (take) =>
          prisma.statusEvent.findMany({
            where: { occurredAt: { lt: cutoff } },
            select: { id: true },
            take,
          }),
        (ids) => prisma.statusEvent.deleteMany({ where: { id: { in: ids } } }),
      );
    }
    if (table === 'auditLog') {
      return deleteInBatches(
        (take) =>
          prisma.auditLog.findMany({
            where: { createdAt: { lt: cutoff } },
            select: { id: true },
            take,
          }),
        (ids) => prisma.auditLog.deleteMany({ where: { id: { in: ids } } }),
      );
    }
    return deleteInBatches(
      (take) =>
        prisma.ruijiePortEvent.findMany({
          where: { at: { lt: cutoff } },
          select: { id: true },
          take,
        }),
      (ids) => prisma.ruijiePortEvent.deleteMany({ where: { id: { in: ids } } }),
    );
  }

  /**
   * Delete refresh tokens past their expiry (`expiresAt < now`). Same batched
   * find-then-delete shape as purgeOlderThan so a huge backlog of dead
   * sessions can't block the worker.
   */
  private async purgeExpiredRefreshTokens(): Promise<number> {
    const now = new Date();
    return deleteInBatches(
      (take) =>
        prisma.refreshToken.findMany({
          where: { expiresAt: { lt: now } },
          select: { id: true },
          take,
        }),
      (ids) => prisma.refreshToken.deleteMany({ where: { id: { in: ids } } }),
    );
  }
}
