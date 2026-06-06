import { env } from '@noc/server';
import { buildApp } from './app';

async function main() {
  const app = await buildApp();

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
