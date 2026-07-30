import {
  applyDeviceStatusesByHost,
  clientForRouter,
  updateRouterStatus,
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

    return { devicesSeen: entries.length };
  } finally {
    await client.close();
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
