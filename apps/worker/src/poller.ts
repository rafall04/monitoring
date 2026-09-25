import net from 'node:net';

import {
  applyDeviceStatus,
  applyDeviceStatusesByHost,
  checkConfigDrift,
  clientForRouter,
  getSettings,
  updateRouterStatus,
  uplinkWindowCatchUp,
  type Device,
  type MikrotikClient,
  type RouterMikrotik,
  type StatusEngineDeps,
} from '@noc/server';
import { REDIS_KEYS, type DeviceStatus } from '@noc/shared';

export interface PollHooks {
  /**
   * Called with the freshly created client as soon as it exists, so the caller
   * can force-close its socket (`abort()`) when a poll deadline expires while a
   * command is still in flight — otherwise the wedged socket lingers until GC.
   */
  onClient?: (client: MikrotikClient) => void;
}

/**
 * Poll one router's Netwatch table and reconcile device statuses. Also refreshes
 * the router's resource cache. This is the heartbeat/reconciliation path that
 * complements the realtime webhook. Throws on connection failure so the
 * scheduler can apply its circuit breaker.
 */
export async function pollRouter(
  deps: StatusEngineDeps,
  router: RouterMikrotik,
  hooks?: PollHooks,
): Promise<{ devicesSeen: number }> {
  const client = clientForRouter(router);
  hooks?.onClient?.(client);
  try {
    const resource = await client.getResource();
    await updateRouterStatus(deps, router, 'online', resource);

    const entries = await client.listNetwatch();
    await applyDeviceStatusesByHost(
      deps,
      router.id,
      entries
        .filter((e) => e.host)
        .map((e) => ({
          host: e.host,
          status: (e.status === 'up' ? 'up' : e.status === 'down' ? 'down' : 'unknown') as DeviceStatus,
        })),
      'polling',
    );

    await reconcileNetwatchFlags(deps, router.id, entries.map((e) => e.host).filter(Boolean));

    await pollUplinkInterfaces(deps, router.id, client);

    // Config drift watch (opt-out via `router.watchConfig`): snapshot the
    // firewall menus and diff them against the last snapshot in Redis. Ping
    // and netwatch stay green while a hand-edited — or killed — dst-nat
    // quietly leaves the monitored service dead; this watch is how we see it.
    // .catch-wrapped like every auxiliary watch: a drift-check bug must NEVER
    // fail the poll, or the scheduler's circuit breaker would mark a healthy
    // router offline and take monitoring down with it.
    if (router.watchConfig) {
      await checkConfigDrift(deps, router, client).catch((e) =>
        deps.logger.warn({ e, routerId: router.id }, 'config drift check failed'),
      );
    }
    // TCP port watches — the "host up, service dead" probe. Same rule: an
    // auxiliary watch failure must not take the poll down.
    await pollTcpDevices(deps, router.id).catch((e) =>
      deps.logger.warn({ e, routerId: router.id }, 'tcp watch probe failed'),
    );
    // NAT traffic watch — a dst-nat forward that is disabled or whose byte
    // counter stalls means data silently stopped flowing while every ping
    // stays green; this probe watches the traffic itself. Same rule: an
    // auxiliary watch failure must not take the poll down.
    await pollNatTraffic(deps, router.id, client).catch((e) =>
      deps.logger.warn({ e, routerId: router.id }, 'nat traffic watch failed'),
    );

    return { devicesSeen: entries.length };
  } finally {
    await client.close();
  }
}

/**
 * Reconcile interface-watch ("uplink") devices: status follows the named
 * interface's `running` flag — a cable/port that went down never produces a
 * Netwatch entry, so it needs its own probe.
 *
 * Three-state truth, never a blind verdict:
 *   interface missing from /interface/print → 'unknown' (config drift —
 *   the device shows the problem on the map without crying outage);
 *   present but disabled or not running    → 'down';
 *   running                                 → 'up'.
 * Alerts for these devices are gated by their work-hours window inside
 * notify; the catch-up here sends the "still down as the window opens" alert.
 */
async function pollUplinkInterfaces(
  deps: StatusEngineDeps,
  routerId: string,
  client: MikrotikClient,
): Promise<void> {
  const uplinks = await deps.prisma.device.findMany({
    where: { routerId, watchInterface: { not: null } },
  });
  if (uplinks.length === 0) return;

  const ifaces = await client.listInterfaces();
  const byName = new Map(ifaces.map((i) => [i.name, i]));
  const stillDown: Device[] = [];

  for (const d of uplinks) {
    const iface = byName.get(d.watchInterface!);
    const next: DeviceStatus = !iface
      ? 'unknown'
      : iface.disabled || !iface.running
        ? 'down'
        : 'up';
    await applyDeviceStatus(deps, d, next, 'interface');
    // The fetched row's `status` is stale after apply — carry the verdict we
    // just wrote so the catch-up sees "down now", not "down before".
    if (next === 'down') stillDown.push({ ...d, status: next });
  }

  if (stillDown.length > 0) {
    await uplinkWindowCatchUp(deps, stillDown, await getSettings());
  }
}

/**
 * Reconcile TCP-port-watch devices: `Device.watchPort` marks a service probe —
 * Netwatch only pings the host, and a killed dst-nat leaves ping green while
 * the service behind it is dead. The probe owns this device's status (the
 * status engine skips watchPort rows in netwatch reconciliation, and the
 * work-hours gating + catch-up treat it exactly like an uplink device).
 *
 * Same three-state discipline as the interface watch: a device with no IP is
 * 'unknown' (config gap on our side — show it on the map without crying
 * outage); a refused or timed-out connect is 'down'; connected is 'up'.
 */
async function pollTcpDevices(
  deps: StatusEngineDeps,
  routerId: string,
): Promise<void> {
  const devices = await deps.prisma.device.findMany({
    where: { routerId, watchPort: { not: null } },
  });
  if (devices.length === 0) return;

  const stillDown: Device[] = [];
  for (const d of devices) {
    const next: DeviceStatus = !d.ipAddress
      ? 'unknown' // nothing to aim the probe at — mirrors the missing-interface case
      : (await probeTcp(d.ipAddress, d.watchPort!, 4000))
        ? 'up'
        : 'down';
    await applyDeviceStatus(deps, d, next, 'tcp');
    // The fetched row's `status` is stale after apply — carry the verdict we
    // just wrote so the catch-up sees "down now", not "down before".
    if (next === 'down') stillDown.push({ ...d, status: next });
  }

  if (stillDown.length > 0) {
    await uplinkWindowCatchUp(deps, stillDown, await getSettings());
  }
}

/**
 * Persisted per-device NAT counter baseline, stored as JSON at
 * `REDIS_KEYS.deviceNatWatch(deviceId)` (`noc:device:<id>:natwatch`).
 * `firstSeenAt` is when this watch first observed the rule; `lastGrowthAt`
 * is the last poll whose byte counter had grown — the stale clock the
 * 'down' verdict is measured against.
 */
interface NatWatchState {
  bytes: number;
  lastGrowthAt: string | null;
  firstSeenAt: string;
}

/**
 * Reconcile NAT-traffic-watch devices: `Device.watchNatDstPort` pins the
 * device to the `dst-port` of a dstnat rule, and the rule's byte counter —
 * not a ping — is the truth. A killed or disabled dst-nat leaves netwatch
 * and TCP probes green while the forward silently stops passing data; this
 * watch reads `/ip firewall nat` and owns the device's status for it.
 *
 * Three-state truth, never a blind verdict:
 *   no dstnat rule on that dst-port → 'unknown' (config drift — show it on
 *       the map without crying outage), and the stored baseline is dropped
 *       because a recreated rule restarts the counter anyway;
 *   rule present but disabled       → 'down' — the forward is OFF, this is
 *       the incident case: someone disabled the dst-nat;
 *   enabled                         → compare `bytes` against the Redis
 *       baseline: growing is 'up'; flat is 'up' inside the grace window
 *       (`watchNatStaleMin`, default 5) and 'down' past it; a shrunken
 *       counter means the rule was recreated or the router rebooted, so it
 *       re-baselines instead of reading a false stall.
 * One fresh observation alone can't prove flow, so a first read (or a
 * zero-byte re-baseline) lands on 'unknown', not 'up'.
 */
async function pollNatTraffic(
  deps: StatusEngineDeps,
  routerId: string,
  client: MikrotikClient,
): Promise<void> {
  const devices = await deps.prisma.device.findMany({
    where: { routerId, watchNatDstPort: { not: null } },
  });
  if (devices.length === 0) return;

  const natRules = await client.listFirewallRaw('nat');
  const stillDown: Device[] = [];

  for (const d of devices) {
    const key = REDIS_KEYS.deviceNatWatch(d.id);
    const rule = natRules.find(
      (r) => r.chain === 'dstnat' && String(r['dst-port']) === d.watchNatDstPort,
    );

    let next: DeviceStatus;
    if (!rule) {
      next = 'unknown';
      // Rule is gone — the byte baseline is meaningless; don't leave stale
      // state behind for a recreated rule to be misjudged against.
      await deps.redisPub.del(key);
    } else if (rule.disabled === true || rule.disabled === 'true' || rule.disabled === 'yes') {
      next = 'down';
      // Forward is OFF — no traffic can flow, so no baseline to keep either.
      await deps.redisPub.del(key);
    } else {
      const bytes = Number(rule.bytes ?? 0);
      const now = new Date();
      const nowIso = now.toISOString();

      let prev: NatWatchState | null = null;
      try {
        const raw = await deps.redisPub.get(key);
        prev = raw ? (JSON.parse(raw) as NatWatchState) : null;
      } catch {
        prev = null; // corrupt state reads as first sight, not a crash
      }

      let state: NatWatchState;
      if (!prev || typeof prev.bytes !== 'number') {
        const firstSeenAt = nowIso;
        state = {
          bytes,
          // Counter already non-zero counts as observed growth; a zeroed
          // rule starts the stale clock at first sight so a forward that
          // never passes traffic still trips 'down' after the grace window.
          lastGrowthAt: bytes > 0 ? nowIso : firstSeenAt,
          firstSeenAt,
        };
        next = 'unknown'; // one observation can't prove flow — honest first read
      } else if (bytes > prev.bytes) {
        state = { bytes, lastGrowthAt: nowIso, firstSeenAt: prev.firstSeenAt ?? nowIso };
        next = 'up';
      } else if (bytes === prev.bytes) {
        // Flat counter — grace period first: it was still flowing last we
        // knew; only when nothing has grown for `staleMin` is it 'down'.
        state = {
          bytes,
          lastGrowthAt: prev.lastGrowthAt ?? null,
          firstSeenAt: prev.firstSeenAt ?? nowIso,
        };
        const staleMin = d.watchNatStaleMin ?? 5;
        const lastGrowthMs = prev.lastGrowthAt ? Date.parse(prev.lastGrowthAt) : NaN;
        next = now.getTime() - lastGrowthMs > staleMin * 60_000 ? 'down' : 'up';
      } else {
        // Counter went backwards — rule deleted+recreated or router rebooted.
        // Re-baseline rather than read a false stall out of the drop.
        state = { bytes, lastGrowthAt: nowIso, firstSeenAt: nowIso };
        next = bytes > 0 ? 'up' : 'unknown';
      }
      // Write the (possibly unchanged) state back every poll so firstSeenAt
      // and lastGrowthAt persist across restarts of this worker.
      await deps.redisPub.set(key, JSON.stringify(state));
    }

    await applyDeviceStatus(deps, d, next, 'traffic');
    // The fetched row's `status` is stale after apply — carry the verdict we
    // just wrote so the catch-up sees "down now", not "down before".
    if (next === 'down') stillDown.push({ ...d, status: next });
  }

  if (stillDown.length > 0) {
    await uplinkWindowCatchUp(deps, stillDown, await getSettings());
  }
}

/**
 * One-shot TCP connect probe. Resolves `true` only when the handshake
 * completes within `timeoutMs`; refusal, reset, DNS failure and timeout all
 * resolve `false` — a probe reports a verdict, it must never throw one into
 * the poll path.
 */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: net.Socket;
    try {
      socket = net.connect({ host, port });
    } catch {
      // e.g. an out-of-range port throws synchronously — still just 'down'.
      resolve(false);
      return;
    }
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up); // resolves once — a late event after a verdict is a no-op
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Make `Device.netwatchSynced` mean "this device really has an entry on the
 * router right now", by comparing against the table we just read.
 *
 * It used to be a one-shot flag set only when the app itself installed the
 * entry, so it lied about anything created another way — entries pasted into
 * the router terminal, or devices written straight to the DB by an import
 * script. In production that left 169 of 197 devices flagged un-synced while
 * every one of them was in fact being watched, and the delete path (which
 * trusted the flag before removing the router entry) would have orphaned them.
 *
 * Only rows whose value actually differs are written, so a steady state costs
 * two no-op UPDATEs per poll.
 */
async function reconcileNetwatchFlags(
  deps: StatusEngineDeps,
  routerId: string,
  hosts: string[],
): Promise<void> {
  try {
    const [marked, cleared] = await Promise.all([
      deps.prisma.device.updateMany({
        where: { routerId, netwatchSynced: false, ipAddress: { in: hosts } },
        data: { netwatchSynced: true },
      }),
      deps.prisma.device.updateMany({
        // `NOT (ipAddress IN (…))` evaluates to NULL — never TRUE — for a NULL
        // ipAddress, so a device that lost its IP while flagged synced would
        // stay flagged forever. Match it explicitly.
        where: {
          routerId,
          netwatchSynced: true,
          OR: [{ ipAddress: null }, { NOT: { ipAddress: { in: hosts } } }],
        },
        data: { netwatchSynced: false },
      }),
    ]);
    if (marked.count || cleared.count) {
      deps.logger.info(
        { routerId, marked: marked.count, cleared: cleared.count },
        'netwatch sync flags reconciled',
      );
    }
  } catch (e) {
    // Never let bookkeeping break the monitoring path.
    deps.logger.warn({ e, routerId }, 'netwatch flag reconciliation failed');
  }
}
