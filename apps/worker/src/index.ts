import {
  createLogger,
  createRedis,
  env,
  prisma,
  type StatusEngineDeps,
} from '@noc/server';
import { startHealthServer } from './health';
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
  const health = startHealthServer(env.WORKER_HEALTH_PORT, () => scheduler.stats);
  scheduler.start();

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
    health.close();
    await redisPub.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
