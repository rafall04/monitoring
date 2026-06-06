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
