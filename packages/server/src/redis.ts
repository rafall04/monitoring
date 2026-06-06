import IORedis, { type Redis } from 'ioredis';
import { REDIS_CHANNELS, type WsServerEvent } from '@noc/shared';
import { env } from './env';

/**
 * Create a Redis connection. Use a dedicated connection for subscribing
 * (a subscriber connection cannot issue normal commands).
 */
export function createRedis(role: string): Redis {
  return new IORedis(env.REDIS_URL, {
    connectionName: `noc-${role}`,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
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
