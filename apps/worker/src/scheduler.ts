import {
  applyDeviceStatus,
  env,
  prisma,
  updateRouterStatus,
  type Logger,
  type RouterMikrotik,
  type StatusEngineDeps,
} from '@noc/server';
import { pollRouter } from './poller';

interface RouterState {
  lastPolled: number;
  failures: number;
  nextAllowed: number; // circuit-breaker: do not poll before this time
}

export interface SchedulerStats {
  lastTick: number;
  routerCount: number;
  polling: boolean;
}

/**
 * Polls each router on its own interval. Routers are sharded across worker
 * instances by id hash so the fleet can be scaled horizontally. A per-router
 * circuit breaker backs off failing routers without blocking the others.
 */
export class PollScheduler {
  private readonly deps: StatusEngineDeps;
  private readonly logger: Logger;
  private routers: RouterMikrotik[] = [];
  private readonly state = new Map<string, RouterState>();
  private lastReload = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  private readonly tickMs = 5000;
  private readonly reloadMs = 60000;
  private readonly concurrency = 8;
  private readonly maxBackoffMs = 300000;
  // Consecutive poll failures before we declare the router's devices stale and
  // flip them to `unknown`. >1 so a single transient timeout doesn't flap.
  private readonly reconcileAfterFailures = 2;

  public stats: SchedulerStats = { lastTick: 0, routerCount: 0, polling: false };

  constructor(deps: StatusEngineDeps, logger: Logger) {
    this.deps = deps;
    this.logger = logger;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private inShard(id: string): boolean {
    if (env.WORKER_SHARD_COUNT <= 1) return true;
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % env.WORKER_SHARD_COUNT === env.WORKER_SHARD_INDEX;
  }

  private async reload(): Promise<void> {
    const all = await prisma.routerMikrotik.findMany();
    this.routers = all.filter((r) => this.inShard(r.id));
    this.stats.routerCount = this.routers.length;
  }

  private isDue(router: RouterMikrotik, now: number): boolean {
    const st = this.state.get(router.id);
    if (st && now < st.nextAllowed) return false;
    const intervalMs =
      (router.pollIntervalSec ?? env.POLL_INTERVAL_DEFAULT_SEC) * 1000;
    return !st || now - st.lastPolled >= intervalMs;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stats.polling = true;
    try {
      const now = Date.now();
      if (now - this.lastReload > this.reloadMs) {
        await this.reload();
        this.lastReload = now;
      }
      const due = this.routers.filter((r) => this.isDue(r, now));
      if (due.length > 0) await this.runPool(due);
      this.stats.lastTick = Date.now();
    } catch (err) {
      this.logger.error({ err }, 'scheduler tick failed');
    } finally {
      this.running = false;
      this.stats.polling = false;
    }
  }

  private async runPool(routers: RouterMikrotik[]): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < routers.length) {
        const router = routers[cursor++];
        if (!router) break;
        await this.pollOne(router);
      }
    };
    const lanes = Math.min(this.concurrency, routers.length);
    await Promise.all(Array.from({ length: lanes }, () => worker()));
  }

  private async pollOne(router: RouterMikrotik): Promise<void> {
    const st = this.state.get(router.id) ?? {
      lastPolled: 0,
      failures: 0,
      nextAllowed: 0,
    };
    try {
      const { devicesSeen } = await pollRouter(this.deps, router);
      st.failures = 0;
      st.nextAllowed = 0;
      this.logger.debug({ routerId: router.id, devicesSeen }, 'polled router');
    } catch (err) {
      st.failures++;
      const backoff = Math.min(this.maxBackoffMs, 5000 * 2 ** Math.min(st.failures, 6));
      st.nextAllowed = Date.now() + backoff;
      this.logger.warn(
        {
          routerId: router.id,
          host: router.host,
          failures: st.failures,
          backoffMs: backoff,
          err: (err as Error)?.message ?? String(err),
        },
        'router poll failed (circuit breaker engaged)',
      );
      await updateRouterStatus(this.deps, router, 'offline', null).catch(() => undefined);
      // Once the router is confirmed offline (not a one-off timeout), its
      // devices' real status is unknowable — leaving them green would make the
      // dashboard lie during the exact event operators care about. Flip them to
      // `unknown` exactly once on crossing the threshold; recovery polls restore
      // real up/down from Netwatch. The status engine no-ops unchanged status.
      if (st.failures === this.reconcileAfterFailures) {
        await this.reconcileDevicesUnknown(router).catch((e) =>
          this.logger.warn(
            { routerId: router.id, err: (e as Error)?.message ?? String(e) },
            'device reconciliation failed',
          ),
        );
      }
    } finally {
      st.lastPolled = Date.now();
      this.state.set(router.id, st);
    }
  }

  /** Mark a dead router's currently up/down devices as `unknown`. */
  private async reconcileDevicesUnknown(router: RouterMikrotik): Promise<void> {
    const devices = await prisma.device.findMany({
      where: { routerId: router.id, status: { in: ['up', 'down'] } },
    });
    if (devices.length === 0) return;
    for (const device of devices) {
      await applyDeviceStatus(this.deps, device, 'unknown', 'polling');
    }
    this.logger.info(
      { routerId: router.id, count: devices.length },
      'reconciled devices to unknown (router offline)',
    );
  }
}
