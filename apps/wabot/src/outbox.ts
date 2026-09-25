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

const MAX_ATTEMPTS = 5;
/** Gentle pacing between sends — WhatsApp rate-limits bursty senders. */
const SEND_DELAY_MS = 400;

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

  private async deliver(p: WaOutboxPayload): Promise<void> {
    try {
      await this.deps.sender.sendText(p.to, p.text);
      await this.deps.prisma.waMessage.update({
        where: { id: p.id },
        data: { status: 'sent', attempts: { increment: 1 } },
      });
      await sleep(SEND_DELAY_MS);
    } catch (err) {
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
