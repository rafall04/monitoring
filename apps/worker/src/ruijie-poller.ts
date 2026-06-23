import { pollRuijieAccount, prisma, type Logger } from '@noc/server';

const TICK_MS = 15_000;
const DEFAULT_INTERVAL_SEC = 60;

export interface RuijieStats {
  lastTick: number;
  accounts: number;
  last: string;
}

/**
 * Polls each Ruijie Cloud account on its own interval (default 60s). ONE call
 * per account returns the whole fleet (status + per-router client count), so
 * this is cheap and stays far under the 5,000/day API cap. Unlike the MikroTik
 * scheduler it is NOT sharded — it must run on exactly one worker instance (the
 * primary shard) so multiple instances don't double-poll the shared daily quota.
 */
export class RuijiePoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastPolled = new Map<string, number>();
  public stats: RuijieStats = { lastTick: 0, accounts: 0, last: '' };

  constructor(private readonly logger: Logger) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    this.stats.lastTick = Date.now();
    let accounts;
    try {
      accounts = await prisma.ruijieAccount.findMany();
    } catch (e) {
      this.logger.warn({ err: (e as Error).message }, 'ruijie: load accounts failed');
      return;
    }
    this.stats.accounts = accounts.length;

    const now = Date.now();
    for (const acc of accounts) {
      const intervalMs = (acc.pollIntervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
      if (now - (this.lastPolled.get(acc.id) ?? 0) < intervalMs) continue;
      this.lastPolled.set(acc.id, now);

      const r = await pollRuijieAccount(acc);
      if (r.ok) {
        this.stats.last = `${acc.label}: ${r.online}/${r.devices} online · ${r.totalClients} clients`;
        this.logger.info(
          { account: acc.label, devices: r.devices, online: r.online, clients: r.totalClients },
          'ruijie polled',
        );
      } else {
        this.stats.last = `${acc.label}: ERROR ${r.error}`;
        this.logger.warn({ account: acc.label, err: r.error }, 'ruijie poll failed');
      }
    }
  }
}
