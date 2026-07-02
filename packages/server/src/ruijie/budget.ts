// =============================================================================
// Shared daily API budget for the Ruijie Cloud account.
//
// Ruijie enforces 5,000 requests/day per account (and 20/sec, irrelevant here).
// That single cap is split across everything that talks to the cloud: the 60s
// fleet poll, the port poller, the WiFi enricher, and human-triggered UI
// drill-downs. Before this guard existed the background scans could burn the
// whole cap and starve the fleet poll into "Too many requests" errors — the
// dashboard would silently go stale during exactly the outages it exists to
// show.
//
// The counter lives in Redis (shared across worker shards + the backend) under a
// UTC-date key, so it resets each day and multiple processes see one total. Every
// upstream call increments it via the client's onSpend hook, so counting is
// accurate regardless of which process made the call. Lower-priority tasks yield
// first by refusing to spend below their reserve (fleet > port > enricher).
// =============================================================================

import type { Redis } from '../redis';

export const RUIJIE_DAILY_CAP = Number(process.env.RUIJIE_DAILY_CAP ?? 5000);

// Reserves: a task stops spending when the remaining budget drops below its
// floor, holding that headroom for higher-priority work. The fleet poll (d<->
// dashboard truth) has no reserve — it always runs while any budget is left.
// The port poller yields first-ish; the enricher (lowest value, heaviest) yields
// earliest, leaving room for fleet polls + drill-downs through end of day.
export const RUIJIE_RESERVE_PORT = Number(process.env.RUIJIE_RESERVE_PORT ?? 1000);
export const RUIJIE_RESERVE_ENRICHER = Number(process.env.RUIJIE_RESERVE_ENRICHER ?? 1600);

function utcDayKey(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `noc:ruijie:budget:${y}-${m}-${d}`;
}

/**
 * Redis-backed daily call counter. Construct once per process from that
 * process's Redis handle; pass `spend` as the client's onSpend hook so every
 * upstream request is counted, and check `remaining()` before a background tick.
 */
export class RuijieBudget {
  constructor(
    private readonly redis: Redis,
    private readonly cap: number = RUIJIE_DAILY_CAP,
  ) {}

  /** Count one (or n) upstream call(s). Fire-and-forget safe. */
  spend = async (n = 1): Promise<void> => {
    try {
      const key = utcDayKey();
      const total = await this.redis.incrby(key, n);
      // First write of the day: give the key a TTL so old day-keys self-clean.
      // The date in the name already guarantees correctness; TTL is just GC.
      if (total === n) await this.redis.expire(key, 172_800); // 2 days
    } catch {
      // Never let budget accounting break a real call.
    }
  };

  async spent(): Promise<number> {
    try {
      const v = await this.redis.get(utcDayKey());
      return v ? Number(v) : 0;
    } catch {
      return 0;
    }
  }

  async remaining(): Promise<number> {
    return Math.max(0, this.cap - (await this.spent()));
  }

  /** True if at least `reserve + need` budget is left (default reserve 0). */
  async canSpend(need = 1, reserve = 0): Promise<boolean> {
    return (await this.remaining()) >= reserve + need;
  }
}
