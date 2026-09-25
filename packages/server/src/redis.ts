import IORedis, { type Redis } from 'ioredis';
import { REDIS_CHANNELS, type WsServerEvent } from '@noc/shared';
import { env } from './env';
import { createLogger } from './logger';

const log = createLogger('redis');

/**
 * Create a Redis connection. Use a dedicated connection for subscribing
 * (a subscriber connection cannot issue normal commands).
 */
export function createRedis(role: string): Redis {
  const client = new IORedis(env.REDIS_URL, {
    connectionName: `noc-${role}`,
    // Keep commands queueing across reconnects (a subscriber needs it), but
    // bound the wait: without commandTimeout a Redis outage parks every queued
    // command forever because maxRetriesPerRequest: null never gives up.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    commandTimeout: 5000,
    // Bounded backoff between reconnect attempts so a Redis outage can't
    // reconnect-storm the server.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  // An ioredis client with no 'error' listener turns every connection error
  // into an uncaughtException that crashes the process (the backend has no
  // global handlers). Absorb and log instead — reconnects are handled by
  // retryStrategy above.
  client.on('error', (err) => {
    log.warn({ role, err: (err as Error)?.message ?? String(err) }, 'redis client error');
  });
  return client;
}

/** Publish a realtime event to a site's fan-out channel. */
export async function publishSiteEvent(
  pub: Redis,
  siteId: string,
  event: WsServerEvent,
): Promise<void> {
  await pub.publish(REDIS_CHANNELS.siteEvents(siteId), JSON.stringify(event));
}

export type { Redis };
