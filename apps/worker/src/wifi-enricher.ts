import {
  prisma,
  ruijieClientForAccount,
  RUIJIE_RESERVE_ENRICHER,
  type Logger,
  type Redis,
  type RuijieBudget,
  type RuijieClientStation,
} from '@noc/server';
import { REDIS_KEYS, type DeviceWifiLink, type SiteWifiMap } from '@noc/shared';

// WiFi enrichment is the EXPENSIVE Ruijie path: getClients is per-building-group
// (no root aggregation), so each monitored group costs one API call per cycle.
// At ~15 groups/cycle a 5-min interval was ~4,460 calls/day — the single biggest
// consumer of the shared 5,000/day quota, and it starved the fleet poll into
// daily "Too many requests" storms. 15 min keeps device⇄AP correlation fresh
// enough (it only labels which AP a device sits on) while freeing quota for the
// port poller. Device counts stay live via the 60s fleet poll.
const INTERVAL_MS = 900_000;
// Cache TTL > interval so one or two missed ticks don't blank the site WiFi map,
// but stale data still expires if the enricher stops entirely.
const TTL_SEC = 2700;

export interface WifiEnricherStats {
  lastTick: number;
  apiCalls: number;
  sites: number;
  links: number;
}

/** Strength compare: RSSI is negative dBm, closer to 0 = stronger. */
function stronger(a: number | null, b: number | null): boolean {
  return (a ?? -999) > (b ?? -999);
}

/**
 * Periodically correlates registered NOC devices to the Ruijie WiFi AP they are
 * connected to (matched by IP) and caches the per-site result in Redis for the
 * read-only site page. Primary-shard only — shares the account's daily API quota.
 */
export class WifiEnricher {
  private timer: NodeJS.Timeout | null = null;
  public stats: WifiEnricherStats = { lastTick: 0, apiCalls: 0, sites: 0, links: 0 };

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly budget: RuijieBudget,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    this.stats.lastTick = Date.now();
    try {
      const account = await prisma.ruijieAccount.findFirst();
      if (!account) return;
      const groupSiteMap = (account.groupSiteMap as Record<string, string> | null) ?? {};
      if (Object.keys(groupSiteMap).length === 0) return;

      // Lowest-priority Ruijie consumer: yield the daily quota to the fleet poll,
      // port poller, and drill-downs by skipping the whole cycle when the budget
      // has dropped into the enricher reserve. Counts stay live via the fleet poll.
      if ((await this.budget.remaining()) < RUIJIE_RESERVE_ENRICHER) {
        this.logger.info('wifi-enricher: skipped (budget reserve)');
        return;
      }

      // Resolve each monitored building group → (siteId, total client count) so we
      // only spend an API call on groups that actually have clients to drill into.
      const routers = await prisma.ruijieRouter.findMany({ where: { accountId: account.id } });
      const groups = new Map<string, { siteId: string; clients: number }>();
      for (const r of routers) {
        const siteId = groupSiteMap[r.groupName];
        if (!siteId) continue;
        const g = groups.get(r.cloudGroupId) ?? { siteId, clients: 0 };
        g.clients += r.clientCount;
        groups.set(r.cloudGroupId, g);
      }

      const client = ruijieClientForAccount(account, this.budget.spend);
      const stationsBySite = new Map<string, RuijieClientStation[]>();
      let apiCalls = 0;
      try {
        for (const [groupId, g] of groups) {
          if (g.clients <= 0) continue; // nothing connected → skip the call
          apiCalls++;
          try {
            const stations = await client.getClients(groupId);
            const acc = stationsBySite.get(g.siteId) ?? [];
            acc.push(...stations);
            stationsBySite.set(g.siteId, acc);
          } catch (e) {
            this.logger.warn(
              { groupId, err: (e as Error).message },
              'wifi-enricher: getClients failed',
            );
          }
        }
      } finally {
        await client.close().catch(() => undefined);
      }

      let totalLinks = 0;
      for (const [siteId, stations] of stationsBySite) {
        const devices = await prisma.device.findMany({
          where: { siteId, ipAddress: { not: null } },
          select: { id: true, ipAddress: true },
        });
        const ipToId = new Map(devices.map((d) => [d.ipAddress!, d.id]));

        const links: Record<string, DeviceWifiLink> = {};
        const bestRssi: Record<string, number | null> = {};
        for (const s of stations) {
          if (!s.ip) continue;
          const deviceId = ipToId.get(s.ip);
          if (!deviceId) continue;
          // A roaming client can appear under two APs; keep the strongest signal.
          if (deviceId in links && !stronger(s.rssi, bestRssi[deviceId] ?? null)) continue;
          bestRssi[deviceId] = s.rssi;
          links[deviceId] = {
            apName: s.apName,
            ssid: s.ssid,
            band: s.band,
            rssi: s.rssi,
            hostname: s.hostname,
            mac: s.mac,
            onlineSince: s.onlineSince,
          };
        }
        totalLinks += Object.keys(links).length;
        const payload: SiteWifiMap = { updatedAt: new Date().toISOString(), links };
        await this.redis.set(REDIS_KEYS.siteWifi(siteId), JSON.stringify(payload), 'EX', TTL_SEC);
      }

      this.stats = {
        lastTick: this.stats.lastTick,
        apiCalls,
        sites: stationsBySite.size,
        links: totalLinks,
      };
      this.logger.info(
        { apiCalls, sites: stationsBySite.size, links: totalLinks },
        'wifi enriched',
      );
    } catch (e) {
      this.logger.warn({ err: (e as Error).message }, 'wifi-enricher tick failed');
    }
  }
}
