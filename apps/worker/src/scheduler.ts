import {
  applyDeviceStatus,
  env,
  prisma,
  publishSiteSummary,
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
  /**
   * Set once this outage's devices have been reconciled to `unknown`. The
   * reconcile fires on EVERY failure past the threshold until it completes
   * once (a crash mid-batch must not leave devices stuck on a stale status);
   * reset when the router polls healthy again.
   */
  reconciled: boolean;
}

/**
 * Reject if `p` does not settle within `ms`. The underlying promise is left to
 * resolve/reject on its own — the point is that the *caller* is freed so a hung
 * router poll can't block the scheduler. `onTimeout` lets the caller release
 * resources the overdue work still holds (e.g. force-close the wedged RouterOS
 * socket) instead of waiting on GC.
 */
function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* best effort */
      }
      reject(new Error(`${label} exceeded ${ms}ms deadline`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
  private runningSince = 0;
  /** Size of the batch currently in flight — feeds the scaled stuck threshold. */
  private lastDueCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  private readonly tickMs = 5000;
  private readonly reloadMs = 60000;
  private readonly concurrency = 8;
  private readonly maxBackoffMs = 300000;
  // Hard ceiling for a single router poll. node-routeros only bounds the connect
  // phase; an already-connected command whose socket dies mid-flight can hang
  // forever (its Channel promise never settles), which would freeze the whole
  // scheduler via the `running` guard. This deadline guarantees every poll
  // settles so a dead router can never wedge the loop.
  private readonly pollDeadlineMs = 25000;
  // Watchdog: if a tick somehow stays `running` far past the deadline, force it
  // free so the scheduler self-heals instead of freezing permanently.
  private readonly watchdogMs = 30000;
  private readonly stuckMs = 120000;
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
    this.watchdog = setInterval(() => this.checkStuck(), this.watchdogMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    this.watchdog = null;
  }

  /** Defense-in-depth: a poll should never outlast its deadline, but if one
   *  somehow does, unstick the scheduler so it keeps polling other routers. */
  private checkStuck(): void {
    // Scale the ceiling with the batch actually in flight: with N due routers
    // over `concurrency` lanes, a perfectly healthy tick can legitimately take
    // (N/concurrency) * pollDeadlineMs. A fixed 120s false-fires on big fleets.
    const threshold = Math.max(
      this.stuckMs,
      (this.lastDueCount / this.concurrency) * this.pollDeadlineMs * 1.5,
    );
    if (this.running && Date.now() - this.runningSince > threshold) {
      this.logger.error(
        {
          stuckMs: Date.now() - this.runningSince,
          thresholdMs: threshold,
          dueCount: this.lastDueCount,
        },
        'scheduler tick stuck past deadline — forcing it free (watchdog)',
      );
      this.running = false;
      this.stats.polling = false;
    }
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
    this.pruneState();
  }

  /**
   * Drop breaker/reconcile state for routers we no longer poll (deleted, or
   * re-sharded to another worker) so the map can't grow without bound. Router
   * state carries no timers of its own — deleting the entry IS the cleanup.
   * Runs on reload (which discovers removals) and defensively on every tick —
   * it's an O(state) sweep that costs nothing on a steady fleet.
   */
  private pruneState(): void {
    const live = new Set(this.routers.map((r) => r.id));
    for (const id of this.state.keys()) {
      if (!live.has(id)) this.state.delete(id);
    }
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
    this.runningSince = Date.now();
    this.stats.polling = true;
    try {
      const now = Date.now();
      if (now - this.lastReload > this.reloadMs) {
        await this.reload();
        this.lastReload = now;
      }
      // Defensive sweep each tick: any router dropped from the working set
      // (deleted mid-interval, or filtered out by a shard re-check) sheds its
      // breaker/reconcile state immediately instead of waiting for reload.
      this.pruneState();
      const due = this.routers.filter((r) => this.isDue(r, now));
      this.lastDueCount = due.length;
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
      reconciled: false,
    };
    // The poller hands its client up so the deadline can force-close the wedged
    // socket (abort()) — otherwise an overdue poll keeps the connection (and
    // its keepalive timers) alive until GC.
    let abortPoll: (() => void) | undefined;
    try {
      const { devicesSeen } = await withDeadline(
        pollRouter(this.deps, router, {
          onClient: (client) => {
            abortPoll = () => (client as { abort?: () => void }).abort?.();
          },
        }),
        this.pollDeadlineMs,
        `poll ${router.host}`,
        () => abortPoll?.(),
      );
      st.failures = 0;
      st.nextAllowed = 0;
      st.reconciled = false; // healthy again — a future outage reconciles afresh
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
      // `unknown` once per outage; recovery polls restore real up/down from
      // Netwatch. Firing only at failures === threshold could miss forever if
      // the reconcile attempt itself crashed — so retry on EVERY subsequent
      // failure until it completes once (reconciled), reset on success above.
      if (st.failures >= this.reconcileAfterFailures && !st.reconciled) {
        try {
          await this.reconcileDevicesUnknown(router);
          st.reconciled = true;
        } catch (e) {
          this.logger.warn(
            { routerId: router.id, err: (e as Error)?.message ?? String(e) },
            'device reconciliation failed',
          );
        }
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
    const changedSites = new Set<string>();
    for (const device of devices) {
      try {
        const changed = await applyDeviceStatus(
          this.deps,
          device,
          'unknown',
          'polling',
          undefined,
          { skipSiteSummary: true },
        );
        if (changed) changedSites.add(device.siteId);
      } catch (e) {
        // One bad row (e.g. P2025 — the device was deleted mid-flight) must not
        // abort the rest of the batch.
        this.logger.warn(
          {
            routerId: router.id,
            deviceId: device.id,
            err: (e as Error)?.message ?? String(e),
          },
          'device reconcile to unknown failed',
        );
      }
    }
    // One site.summary publish per affected site at the end, not per device.
    for (const siteId of changedSites) {
      try {
        await publishSiteSummary(this.deps, siteId);
      } catch (e) {
        this.logger.warn(
          { siteId, err: (e as Error)?.message ?? String(e) },
          'site summary publish failed',
        );
      }
    }
    this.logger.info(
      { routerId: router.id, count: devices.length },
      'reconciled devices to unknown (router offline)',
    );
  }
}
