// =============================================================================
// apps/wabot — the WhatsApp bot process (see docs/whatsapp-bot-plan.md).
// Owns the Baileys socket + session state, consumes the outbound outbox, and
// dispatches inbound commands. Runs as ONE instance — a WhatsApp session can
// never be sharded. Communicates with the rest of the stack only via Redis +
// Postgres (no inbound HTTP besides /health).
// =============================================================================

import {
  MockWaSender,
  createLogger,
  createRedis,
  env,
  prisma,
  publishWaGroups,
  publishWaSession,
  startHealthServer,
  type Redis,
} from '@noc/server';
import type { WhatsAppSender } from '@noc/shared';
import { BaileysSender } from './baileys';
import { ControlConsumer } from './control';
import { OutboxConsumer } from './outbox';
import { InboundRouter } from './router';
import { clearDbAuthState } from './session';
import { withTimeout } from './util';

// A sender that always fails — used when WA_ENABLED=false so queued messages
// retry then go 'dead' instead of stacking forever.
class OfflineWaSender implements WhatsAppSender {
  constructor(private redis: Redis) {}
  async sendText(): Promise<void> {
    throw new Error('WA_ENABLED=false');
  }
  session() {
    return {
      status: 'disabled' as const,
      qr: null,
      phone: null,
      name: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }
  async reconnect(): Promise<void> {}
  async logout(): Promise<void> {
    // Bot disabled — wiping keys still honors "new session" for next enable.
    await clearDbAuthState().catch(() => undefined);
    await publishWaGroups(this.redis, []).catch(() => undefined);
  }
  async refreshGroups(): Promise<void> {
    await publishWaGroups(this.redis, []).catch(() => undefined);
  }
  async close(): Promise<void> {}
}

async function main() {
  const logger = createLogger('wabot');

  // Same rule as the worker: a bot must never crash-loop on a stray async error
  // (Baileys can emit socket errors outside the awaited path).
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: (reason as Error)?.message ?? String(reason) }, 'unhandledRejection (continuing)');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: (err as Error)?.message ?? String(err) }, 'uncaughtException (continuing)');
  });

  const redisPub = createRedis('wabot-pub');
  // BLPOP blocks up to 5s per pop — the default 5s commandTimeout would race
  // it and turn every idle pop into a "Command timed out" error.
  const redisOutbox = createRedis('wabot-outbox', { commandTimeout: 30_000 });
  const redisControl = createRedis('wabot-control', { commandTimeout: 30_000 });

  // `sender` is assigned below; router/sender reference each other through
  // closures that only fire after startup completes.
  let sender: WhatsAppSender;
  const router = new InboundRouter({
    prisma,
    redis: redisPub,
    logger,
    // Inbound replies bypass the outbox for latency — but a hung send must not
    // be a silent stall. The timeout turns it into a logged error instead of
    // an invisible "read but no reply".
    reply: (to, text) => withTimeout(sender.sendText(to, text), 20_000, 'wa reply'),
  });

  if (!env.WA_ENABLED) {
    sender = new OfflineWaSender(redisPub);
  } else if (env.WA_DRIVER === 'mock') {
    sender = new MockWaSender(logger);
  } else {
    sender = new BaileysSender({
      redis: redisPub,
      logger,
      onMessage: async (msg) => router.handle(msg),
    });
  }

  // Expose the session snapshot even for mock/disabled drivers so the pairing
  // UI never shows a stale "offline" from a previous run.
  if (!(sender instanceof BaileysSender)) {
    await publishWaSession(redisPub, sender.session()).catch(() => undefined);
  }

  const outbox = new OutboxConsumer({ prisma, redis: redisOutbox, sender, logger });
  outbox.start();

  const control = new ControlConsumer({ redis: redisControl, sender, logger });
  control.start();

  const health = startHealthServer(env.WABOT_HEALTH_PORT, () => ({
    driver: env.WA_DRIVER,
    enabled: env.WA_ENABLED,
    waConnected: sender.session().status === 'connected',
    session: sender.session(),
  }));

  if (sender instanceof BaileysSender) {
    await sender.start();
  }

  logger.info(
    { enabled: env.WA_ENABLED, driver: env.WA_DRIVER, healthPort: env.WABOT_HEALTH_PORT },
    'wabot started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down wabot');
    outbox.stop();
    control.stop();
    await sender.close().catch(() => undefined);
    health.close();
    await redisOutbox.quit().catch(() => undefined);
    await redisControl.quit().catch(() => undefined);
    await redisPub.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
