import { env } from '@noc/server';
import { buildApp } from './app';

async function main() {
  const app = await buildApp();

  // Mirror the worker's contract: a stray async error (an ioredis 'error'
  // emitted outside an awaited call, a ws send racing a socket close, a bug in
  // a library callback) must not take the whole API down. Log the full stack
  // and keep serving — the real failure is already handled closer to source.
  process.on('unhandledRejection', (reason) => {
    app.log.error(
      { err: reason instanceof Error ? reason : new Error(String(reason)) },
      'unhandledRejection (continuing)',
    );
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaughtException (continuing)');
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.BACKEND_HOST, port: env.BACKEND_PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
