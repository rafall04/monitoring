// =============================================================================
// Realtime contract: WebSocket messages + Redis pub/sub channel names.
// Worker publishes to Redis -> backend WS hub fans out to subscribed clients.
// =============================================================================

import type {
  Device,
  DeviceStatus,
  RouterResource,
  RouterStatus,
  SiteSummary,
  StatusSource,
} from './types';

// ---- Server -> client (over WebSocket) ---------------------------------------

export type WsServerEvent =
  | {
      type: 'device.status';
      siteId: string;
      deviceId: string;
      status: DeviceStatus;
      statusSince: string | null;
      source: StatusSource;
    }
  | { type: 'device.updated'; siteId: string; deviceId: string; device: Device }
  | { type: 'device.created'; siteId: string; device: Device }
  | { type: 'device.deleted'; siteId: string; deviceId: string }
  | {
      type: 'router.status';
      siteId: string;
      routerId: string;
      status: RouterStatus;
      lastSeenAt: string | null;
      resource: RouterResource | null;
    }
  | { type: 'site.summary'; siteId: string; summary: SiteSummary }
  | { type: 'subscribed'; siteId: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

// ---- Client -> server (over WebSocket) ---------------------------------------

export type WsClientEvent =
  | { type: 'subscribe'; siteId: string }
  | { type: 'unsubscribe'; siteId: string }
  | { type: 'ping' };

// ---- Redis pub/sub -----------------------------------------------------------

export const REDIS_CHANNELS = {
  /** Per-site fan-out channel the WS hub subscribes to. */
  siteEvents: (siteId: string) => `noc:site:${siteId}:events`,
  /** Pattern the backend subscribes to in order to receive all site events. */
  siteEventsPattern: 'noc:site:*:events',
} as const;

/** Redis cache keys for last-known device/router status (fast reads, heartbeat). */
export const REDIS_KEYS = {
  deviceStatus: (deviceId: string) => `noc:device:${deviceId}:status`,
  routerStatus: (routerId: string) => `noc:router:${routerId}:status`,
  /** Per-site device→WiFi correlation, refreshed by the worker's WiFi enricher. */
  siteWifi: (siteId: string) => `noc:site:${siteId}:wifi`,
  /** Idempotency guard for webhook dedup (value = last event hash). */
  webhookDedup: (routerId: string, host: string) =>
    `noc:webhook:${routerId}:${host}`,

  // ---- WhatsApp bot (apps/wabot) ----------------------------------------------
  /** Outbound queue — producers LPUSH WaOutboxPayload, wabot BLPOPs it. A list
   *  (not pub/sub) so alerts queue up while the bot is reconnecting. */
  waOutbox: 'noc:wa:outbox',
  /** Latest session snapshot (WaSessionState) written by wabot, read by the
   *  backend to drive the Settings → WhatsApp pairing UI. */
  waSession: 'noc:wa:session',
  /** Groups the bot participates in (WaGroupInfo[]) — wabot refreshes it on
   *  connect/group events; backend serves it so the UI can offer a pick-list
   *  instead of raw JIDs. */
  waGroups: 'noc:wa:groups',
  /** Admin→wabot commands (logout / reconnect). LPUSH → BLPOP — a list like the
   *  outbox so a control op is not lost while the bot restarts. */
  waControl: 'noc:wa:control',
  /** Inbound rate limit per phone (counter with short EX). */
  waRate: (phone: string) => `noc:wa:rate:${phone}`,
  /** Multi-step conversation state (anonymous complaint intake), JSON + TTL. */
  waConv: (phone: string) => `noc:wa:conv:${phone}`,
  /** Alert flap cooldown — mirrors the noc:tgcooldown Telegram key. */
  waCooldown: (deviceId: string, status: string) =>
    `noc:wacooldown:${deviceId}:${status}`,
  /** Inbound dedup — WA re-delivers messages; value = first-seen marker. */
  waSeen: (messageId: string) => `noc:wa:seen:${messageId}`,
  /** Phone-linking code (portal shows it; user texts `LINK <code>` to the bot). */
  waLink: (code: string) => `noc:wa:link:${code}`,
} as const;

/** Parse the siteId out of a `noc:site:<id>:events` channel name. */
export function siteIdFromChannel(channel: string): string | null {
  const m = /^noc:site:(.+):events$/.exec(channel);
  return m ? m[1]! : null;
}
