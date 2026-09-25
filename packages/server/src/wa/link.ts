// =============================================================================
// Phone linking: a logged-in user (member OR staff) asks the portal for a code,
// then texts `LINK <code>` to the bot — proving they own that WhatsApp number.
// The code lives only in Redis (short TTL, single-use via GETDEL).
// =============================================================================

import { randomInt } from 'node:crypto';
import { REDIS_KEYS, WA_LINK_TTL_SEC } from '@noc/shared';
import type { Redis } from '../redis';

// No ambiguous characters (0/O, 1/I/L) — users transcribe these by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

export async function createWaLinkCode(
  redis: Redis,
  userId: string,
): Promise<{ code: string; ttlSec: number }> {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  await redis.set(REDIS_KEYS.waLink(code), userId, 'EX', WA_LINK_TTL_SEC);
  return { code, ttlSec: WA_LINK_TTL_SEC };
}

/** Single-use: returns the userId bound to the code, or null if bad/expired. */
export async function consumeWaLinkCode(redis: Redis, code: string): Promise<string | null> {
  return redis.getdel(REDIS_KEYS.waLink(code.trim().toUpperCase()));
}
