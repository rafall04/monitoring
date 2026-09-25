import {
  createLogger,
  createRedis,
  env,
  prisma,
  RuijieBudget,
  type StatusEngineDeps,
} from '@noc/server';
import { startHealthServer } from './health';
import { RetentionSweeper } from './retention';
import { RuijiePoller } from './ruijie-poller';
import { RuijiePortPoller } from './ruijie-port-poller';
import { PollScheduler } from './scheduler';
import { WifiEnricher } from './wifi-enricher';

async function main() {
  const logger = createLogger('worker');

  // Fail fast on a misconfigured shard: an index >= count means some routers
  // would be polled by NO worker (silent blind spot), and e.g. index 1 of a
  // 1-shard fleet would skip every primary-only job below.
  if (env.WORKER_SHARD_INDEX >= env.WORKER_SHARD_COUNT) {
    logger.error(
      { shardIndex: env.WORKER_SHARD_INDEX, shardCount: env.WORKER_SHARD_COUNT },
      'WORKER_SHARD_INDEX must be < WORKER_SHARD_COUNT — refusing to start',
    );
    process.exit(1);
  }

  // A monitoring poller must never die because one router is unreachable.
  // node-routeros can emit async socket errors (e.g. SOCKTMOUT on a timeout)
  // OUTSIDE the awaited path, which Node turns into an uncaught exception. The
  // scheduler's circuit breaker already handles the real per-router failure, so
  // here we log the stray event and keep the process alive instead of letting it
  // crash-loop.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      // Pass the full Error (not just .message) so pino prints the stack.
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandledRejection (continuing)',
    );
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException (continuing)');
  });

  const redisPub = createRedis('worker-pub');
  const deps: StatusEngineDeps = { prisma, redisPub, logger };

  const scheduler = new PollScheduler(deps, logger);
  // Singleton-ish background jobs run ONLY on the primary shard so multiple
  // worker instances never duplicate them: the Ruijie pollers (shared daily
  // API quota) AND the retention sweeper (global DB delete-scans).
  const primary = env.WORKER_SHARD_INDEX === 0;
  const retention = primary ? new RetentionSweeper(logger) : null;
  // All Ruijie Cloud consumers share ONE daily-budget counter (Redis-backed) so
  // the fleet poll, port poller, and enricher can't collectively blow the
  // 5,000/day cap — lower-priority ones yield via their reserves.
  const ruijieBudget = new RuijieBudget(redisPub);
  const ruijie = primary ? new RuijiePoller(logger, ruijieBudget) : null;
  // Per-SN LAN port sampling → baseline + silent-degradation + flap detection.
  const ruijiePorts = primary ? new RuijiePortPoller(redisPub, logger, ruijieBudget) : null;
  // Device⇄WiFi correlation (heavier per-group API calls) also primary-shard only.
  const wifi = primary ? new WifiEnricher(redisPub, logger, ruijieBudget) : null;
  const health = startHealthServer(env.WORKER_HEALTH_PORT, () => ({
    scheduler: scheduler.stats,
    retention: retention?.stats ?? 'disabled (non-primary shard)',
    ruijie: ruijie?.stats ?? 'disabled (non-primary shard)',
    ruijiePorts: ruijiePorts?.stats ?? 'disabled (non-primary shard)',
    wifi: wifi?.stats ?? 'disabled (non-primary shard)',
  }));
  scheduler.start();
  retention?.start();
  ruijie?.start();
  ruijiePorts?.start();
  wifi?.start();

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
    retention?.stop();
    ruijie?.stop();
    ruijiePorts?.stop();
    wifi?.stop();
    health.close();
    await redisPub.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
