import {
  applyDeviceStatusByHost,
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
    for (const e of entries) {
      if (!e.host) continue;
      const status: DeviceStatus =
        e.status === 'up' ? 'up' : e.status === 'down' ? 'down' : 'unknown';
      await applyDeviceStatusByHost(deps, {
        routerId: router.id,
        host: e.host,
        status,
        source: 'polling',
      });
    }
    return { devicesSeen: entries.length };
  } finally {
    await client.close();
  }
}
