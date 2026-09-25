// =============================================================================
// Control consumer: BLPOPs WaControlMessage off noc:wa:control and applies the
// op to the sender (reconnect / logout). Same delivery guarantee as the
// outbox — an op issued while the bot restarts executes on the next loop.
// =============================================================================

import type { Logger } from 'pino';
import {
  REDIS_KEYS,
  WA_CONTROL_OPS,
  type WaControlMessage,
  type WhatsAppSender,
} from '@noc/shared';
import type { Redis } from '@noc/server';

interface ControlDeps {
  redis: Redis; // dedicated connection — BLPOP blocks it
  sender: WhatsAppSender;
  logger: Logger;
}

export class ControlConsumer {
  private running = false;

  constructor(private deps: ControlDeps) {}

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
        const res = await this.deps.redis.brpop(REDIS_KEYS.waControl, 5);
        if (!res) continue;
        let msg: WaControlMessage | null = null;
        try {
          const parsed = JSON.parse(res[1]) as WaControlMessage;
          if ((WA_CONTROL_OPS as readonly string[]).includes(parsed.op)) msg = parsed;
        } catch {
          /* malformed below */
        }
        if (!msg) {
          this.deps.logger.warn({ raw: res[1] }, 'wa control: malformed op dropped');
          continue;
        }
        this.deps.logger.info({ op: msg.op, by: msg.requestedBy }, 'wa control op');
        try {
          if (msg.op === 'reconnect') await this.deps.sender.reconnect();
          else if (msg.op === 'logout') await this.deps.sender.logout();
          else if (msg.op === 'groups-refresh') await this.deps.sender.refreshGroups();
        } catch (err) {
          this.deps.logger.warn({ err: (err as Error)?.message, op: msg.op }, 'wa control op failed');
        }
      } catch (err) {
        if (!this.running) break;
        this.deps.logger.warn({ err }, 'wa control loop error');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
