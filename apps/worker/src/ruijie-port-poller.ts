import {
  prisma,
  reconcileRouterPorts,
  ruijieClientForAccount,
  RUIJIE_RESERVE_PORT,
  type Logger,
  type PortRouterCtx,
  type Redis,
  type RuijieBudget,
} from '@noc/server';

const TICK_MS = 60_000;
// A healthy port is re-sampled every NORMAL interval; a router that currently
// has a degraded/flapping port is re-checked FAST so a recovery (or worsening)
// is confirmed quickly. Both are per-SN cloud calls against the shared quota.
const NORMAL_INTERVAL_SEC = Number(process.env.RUIJIE_PORT_POLL_SEC ?? 1800); // 30 min
const FAST_INTERVAL_SEC = Number(process.env.RUIJIE_PORT_FAST_SEC ?? 600); // 10 min
// Spread work so one tick never bursts the whole fleet (also stays clear of the
// 20/sec limit): at most this many per-SN calls per 60s tick.
const MAX_PER_TICK = 8;

export interface RuijiePortStats {
  lastTick: number;
  lastPolled: number;
  degraded: number;
  recovered: number;
  flaps: number;
  skippedBudget: boolean;
  last: string;
}

/**
 * Samples Ruijie AP/switch LAN ports on an adaptive interval and feeds each
 * reading through the port-monitor convergence point (baseline + degradation +
 * flap detection + alerts). Primary-shard only (shares the account's daily API
 * quota) and budget-guarded: it yields to the fleet poll + drill-downs by
 * refusing to spend below RUIJIE_RESERVE_PORT.
 */
export class RuijiePortPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly lastChecked = new Map<string, number>();
  public stats: RuijiePortStats = {
    lastTick: 0,
    lastPolled: 0,
    degraded: 0,
    recovered: 0,
    flaps: 0,
    skippedBudget: false,
    last: '',
  };

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly budget: RuijieBudget,
  ) {}

  start(): void {
    // Small delay so the fleet poller populates ruijie_router first.
    setTimeout(() => void this.tick(), 20_000).unref?.();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stats.lastTick = Date.now();
    try {
      const remaining = await this.budget.remaining();
      // Reserve headroom for the fleet poll + human drill-downs.
      const spendable = remaining - RUIJIE_RESERVE_PORT;
      if (spendable <= 0) {
        this.stats.skippedBudget = true;
        return;
      }
      this.stats.skippedBudget = false;

      const account = await prisma.ruijieAccount.findFirst();
      if (!account) return;
      const groupSiteMap = (account.groupSiteMap as Record<string, string> | null) ?? {};

      const routers = await prisma.ruijieRouter.findMany({
        where: { accountId: account.id, online: true },
        select: { id: true, name: true, groupName: true, cloudSerial: true },
      });
      if (routers.length === 0) return;

      // Routers with a currently-degraded port get the FAST interval.
      const degradedRows = await prisma.ruijiePort.findMany({
        where: { degraded: true, router: { accountId: account.id } },
        select: { routerId: true },
      });
      const fast = new Set(degradedRows.map((r) => r.routerId));

      const now = Date.now();
      const due = routers
        .filter((r) => {
          const interval = (fast.has(r.id) ? FAST_INTERVAL_SEC : NORMAL_INTERVAL_SEC) * 1000;
          return now - (this.lastChecked.get(r.id) ?? 0) >= interval;
        })
        // Oldest-checked first so no router is starved when many are due.
        .sort((a, b) => (this.lastChecked.get(a.id) ?? 0) - (this.lastChecked.get(b.id) ?? 0));

      const budgetCap = Math.max(0, Math.floor(spendable));
      const batch = due.slice(0, Math.min(MAX_PER_TICK, budgetCap));
      if (batch.length === 0) return;

      const client = ruijieClientForAccount(account, this.budget.spend);
      let polled = 0;
      let degraded = 0;
      let recovered = 0;
      let flaps = 0;
      try {
        for (const r of batch) {
          this.lastChecked.set(r.id, now);
          try {
            const ports = await client.getPorts(r.cloudSerial);
            const ctx: PortRouterCtx = {
              id: r.id,
              name: r.name,
              groupName: r.groupName,
              siteId: groupSiteMap[r.groupName] ?? null,
            };
            const res = await reconcileRouterPorts(
              { prisma, redis: this.redis, logger: this.logger },
              ctx,
              ports,
            );
            polled += 1;
            degraded += res.degraded;
            recovered += res.recovered;
            flaps += res.flaps;
          } catch (err) {
            this.logger.warn(
              { router: r.name, err: (err as Error).message },
              'ruijie port poll failed',
            );
          }
        }
      } finally {
        await client.close().catch(() => undefined);
      }

      this.stats = {
        lastTick: this.stats.lastTick,
        lastPolled: now,
        degraded,
        recovered,
        flaps,
        skippedBudget: false,
        last: `${polled}/${batch.length} polled · ${degraded} degraded · ${recovered} recovered · ${flaps} flap`,
      };
      if (degraded || recovered || flaps) {
        this.logger.info({ polled, degraded, recovered, flaps }, 'ruijie ports reconciled');
      }
    } catch (e) {
      this.logger.warn({ err: (e as Error).message }, 'ruijie port poller tick failed');
    } finally {
      this.running = false;
    }
  }
}
