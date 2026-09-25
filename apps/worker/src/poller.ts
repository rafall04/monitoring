import {
  applyDeviceStatus,
  applyDeviceStatusesByHost,
  clientForRouter,
  getSettings,
  updateRouterStatus,
  uplinkWindowCatchUp,
  type Device,
  type MikrotikClient,
  type RouterMikrotik,
  type StatusEngineDeps,
} from '@noc/server';
import type { DeviceStatus } from '@noc/shared';

/**
 * Poll one router's Netwatch table and reconcile device statuses. Also refreshes
 * the router's resource cache. This is the heartbeat/reconciliation path that
 * complements the realtime webhook. Throws on connection failure so the
 * scheduler can apply its circuit breaker.
 */
export async function pollRouter(
  deps: StatusEngineDeps,
  router: RouterMikrotik,
): Promise<{ devicesSeen: number }> {
  const client = clientForRouter(router);
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
