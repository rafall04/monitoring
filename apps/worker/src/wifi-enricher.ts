import {
  prisma,
  ruijieClientForAccount,
  type Logger,
  type Redis,
  type RuijieClientStation,
} from '@noc/server';
import { REDIS_KEYS, type DeviceWifiLink, type SiteWifiMap } from '@noc/shared';

// WiFi enrichment is the EXPENSIVE Ruijie path: getClients is per-building-group
// (no root aggregation), so each monitored group costs one API call per cycle.
// A 5-min cycle over the ~10 SF1 groups stays well under the 5,000/day cap while
// the 60s fleet poll keeps counts fresh. Raise the interval if more sites map in.
const INTERVAL_MS = 300_000;
// Cache TTL > interval so a brief enricher hiccup doesn't blank the UI, but stale
// data still expires if the enricher stops entirely.
const TTL_SEC = 1200;

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

      const client = ruijieClientForAccount(account);
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
