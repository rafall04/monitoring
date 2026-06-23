import {
  createLogger,
  createRedis,
  env,
  prisma,
  type StatusEngineDeps,
} from '@noc/server';
import { startHealthServer } from './health';
import { RetentionSweeper } from './retention';
import { RuijiePoller } from './ruijie-poller';
import { PollScheduler } from './scheduler';

async function main() {
  const logger = createLogger('worker');

  // A monitoring poller must never die because one router is unreachable.
  // node-routeros can emit async socket errors (e.g. SOCKTMOUT on a timeout)
  // OUTSIDE the awaited path, which Node turns into an uncaught exception. The
  // scheduler's circuit breaker already handles the real per-router failure, so
  // here we log the stray event and keep the process alive instead of letting it
  // crash-loop.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { reason: (reason as Error)?.message ?? String(reason) },
      'unhandledRejection (continuing)',
    );
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: (err as Error)?.message ?? String(err) }, 'uncaughtException (continuing)');
  });

  const redisPub = createRedis('worker-pub');
  const deps: StatusEngineDeps = { prisma, redisPub, logger };

  const scheduler = new PollScheduler(deps, logger);
  const retention = new RetentionSweeper(logger);
  // The Ruijie poller is NOT sharded — run it only on the primary shard so
  // multiple worker instances never double-poll the shared daily API quota.
  const ruijie = env.WORKER_SHARD_INDEX === 0 ? new RuijiePoller(logger) : null;
  const health = startHealthServer(env.WORKER_HEALTH_PORT, () => ({
    scheduler: scheduler.stats,
    retention: retention.stats,
    ruijie: ruijie?.stats ?? 'disabled (non-primary shard)',
  }));
  scheduler.start();
  retention.start();
  ruijie?.start();

  logger.info(
    {
      shard: `${env.WORKER_SHARD_INDEX}/${env.WORKER_SHARD_COUNT}`,
      defaultIntervalSec: env.POLL_INTERVAL_DEFAULT_SEC,
      healthPort: env.WORKER_HEALTH_PORT,
    },
    'worker started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    scheduler.stop();
    retention.stop();
    ruijie?.stop();
    health.close();
    await redisPub.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
