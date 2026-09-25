// =============================================================================
// WhatsApp outbox. Producers (status engine, ticket forwards, admin test sends)
// write a WaMessage audit row then LPUSH the payload; apps/wabot BLPOPs it.
// A Redis LIST — not pub/sub — so alerts queued while the bot is down are still
// delivered when the socket comes back.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import {
  REDIS_KEYS,
  type WaGroupInfo,
  type WaMessageKind,
  type WaOutboxPayload,
  type WaSessionState,
} from '@noc/shared';
import type { Redis } from '../redis';

export interface WaDeps {
  prisma: PrismaClient;
  redis: Redis;
}

export interface EnqueueWaInput {
  to: string;
  text: string;
  kind: WaMessageKind;
  siteId?: string;
}

/** Queue one outbound message. Returns the WaMessage row id. */
export async function enqueueWaMessage(
  deps: WaDeps,
  input: EnqueueWaInput,
): Promise<string> {
  const row = await deps.prisma.waMessage.create({
    data: {
      to: input.to,
      kind: input.kind,
      body: input.text,
      siteId: input.siteId ?? null,
    },
  });
  const payload: WaOutboxPayload = {
    id: row.id,
    to: input.to,
    text: input.text,
    kind: input.kind,
    siteId: input.siteId,
  };
  await deps.redis.lpush(REDIS_KEYS.waOutbox, JSON.stringify(payload));
  return row.id;
}

// ---- Session snapshot (wabot writes, backend reads) ---------------------------

export async function publishWaSession(redis: Redis, state: WaSessionState): Promise<void> {
  await redis.set(REDIS_KEYS.waSession, JSON.stringify(state));
}

export async function readWaSession(redis: Redis): Promise<WaSessionState | null> {
  const raw = await redis.get(REDIS_KEYS.waSession);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WaSessionState;
  } catch {
    return null;
  }
}

// ---- Participating-group cache (wabot writes, backend reads) ------------------
// The pick-list for kind='group' recipients — a bot can only send to groups it
// belongs to, so the cache doubles as the set of valid targets.

export async function publishWaGroups(redis: Redis, groups: WaGroupInfo[]): Promise<void> {
  await redis.set(REDIS_KEYS.waGroups, JSON.stringify(groups));
}

export async function readWaGroups(redis: Redis): Promise<WaGroupInfo[]> {
  const raw = await redis.get(REDIS_KEYS.waGroups);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WaGroupInfo[]) : [];
  } catch {
    return [];
  }
}
