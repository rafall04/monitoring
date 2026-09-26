// =============================================================================
// Outbox consumer: BLPOPs WaOutboxPayload off noc:wa:outbox, sends via the
// active driver, and marks the WaMessage audit row. Failures are requeued with
// exponential backoff; after MAX_ATTEMPTS the row goes 'dead' so a poisoned
// message can never stall the queue.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { REDIS_KEYS, type WaOutboxPayload, type WhatsAppSender } from '@noc/shared';
import type { Redis } from '@noc/server';
import { withTimeout } from './util';

const MAX_ATTEMPTS = 5;

// ---- Anti-ban pacing ---------------------------------------------------------
// WhatsApp's ban heuristics key on bursty sends and machine-perfect timing —
// exactly what a fixed 400ms loop looks like during a site outage that fires
// dozens of alerts. Every send is jittered, identical broadcast blasts are
// paced much slower, and a rolling per-minute budget makes a long backlog
// drain gently instead of slamming the socket.
const PACE_MIN_MS = 700;
const PACE_MAX_MS = 2200;
/** Kinds whose text is identical across recipients — the worst ban trigger. */
const SLOW_KINDS = new Set<string>(['broadcast']);
const SLOW_MIN_MS = 3000;
const SLOW_MAX_MS = 6500;
const SENDS_PER_MIN = 24;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OutboxDeps {
  prisma: PrismaClient;
  redis: Redis; // dedicated connection — BLPOP blocks it
  sender: WhatsAppSender;
  logger: Logger;
}

export class OutboxConsumer {
  private running = false;

  constructor(private deps: OutboxDeps) {}

  start(): void {
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.deps.redis.brpop(REDIS_KEYS.waOutbox, 5);
        if (!res) continue;
        let payload: WaOutboxPayload | null = null;
        try {
          payload = JSON.parse(res[1]) as WaOutboxPayload;
        } catch {
          this.deps.logger.warn({ raw: res[1] }, 'wa outbox: malformed payload dropped');
        }
        if (payload) await this.deliver(payload);
      } catch (err) {
        if (!this.running) break;
        this.deps.logger.warn({ err }, 'wa outbox loop error');
        await sleep(1000);
      }
    }
  }

  /** Rolling 60s send budget + jittered inter-send delay. */
  private windowStart = 0;
  private sentInWindow = 0;

  private async pace(kind: string | undefined): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.sentInWindow = 0;
    }
    if (++this.sentInWindow > SENDS_PER_MIN) {
      // Budget spent — park the loop until the window rolls (queue survives).
      const wait = this.windowStart + 60_000 - now;
      this.deps.logger.info({ wait }, 'wa outbox: per-minute budget reached, pacing');
      await sleep(wait + 500);
      this.windowStart = Date.now();
      this.sentInWindow = 1;
    }
    const slow = !!kind && SLOW_KINDS.has(kind);
    const lo = slow ? SLOW_MIN_MS : PACE_MIN_MS;
    const hi = slow ? SLOW_MAX_MS : PACE_MAX_MS;
    await sleep(lo + Math.random() * (hi - lo));
  }

  private async deliver(p: WaOutboxPayload): Promise<void> {
    const sender = this.deps.sender;
    try {
      // Human-ish typing presence — scaled to text length, capped ~2.5s.
      if (sender.sendPresence) {
        await withTimeout(sender.sendPresence(p.to, 'composing'), 5_000, 'presence').catch(() => undefined);
        await sleep(Math.min(300 + p.text.length * 12, 600 + Math.random() * 1800));
      }
      // A hung send must NOT jam the queue — bound it so one wedged socket
      // can't stall every alert queued behind it (timeout → normal retry).
      await withTimeout(sender.sendText(p.to, p.text), 30_000, 'wa sendText');
      await withTimeout(sender.sendPresence?.(p.to, 'paused') ?? Promise.resolve(), 5_000, 'presence').catch(() => undefined);
      await this.deps.prisma.waMessage.update({
        where: { id: p.id },
        data: { status: 'sent', attempts: { increment: 1 } },
      });
      await this.pace(p.kind);
    } catch (err) {
      // Failed sends also rest briefly — a dead socket shouldn't hot-loop.
      await sleep(500 + Math.random() * 1000);
      const row = await this.deps.prisma.waMessage
        .update({ where: { id: p.id }, data: { attempts: { increment: 1 }, status: 'failed' } })
        .catch(() => null);
      const attempts = row?.attempts ?? MAX_ATTEMPTS;
      if (attempts < MAX_ATTEMPTS) {
        // Non-blocking requeue: the queue keeps moving while this one waits.
        const delay = Math.min(1000 * 2 ** attempts, 60_000);
        setTimeout(() => {
          void this.deps.redis
            .lpush(REDIS_KEYS.waOutbox, JSON.stringify(p))
            .catch(() => undefined);
        }, delay).unref();
      } else {
        await this.deps.prisma.waMessage
          .update({ where: { id: p.id }, data: { status: 'dead' } })
          .catch(() => undefined);
      }
      this.deps.logger.warn(
        { err: (err as Error)?.message, id: p.id, attempts },
        'wa send failed',
      );
    }
  }
}
