import pino, { type Logger } from 'pino';
import { env, isDev } from './env';

/**
 * Structured logger. Pretty in dev (requires pino-pretty), JSON in prod.
 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: env.LOG_LEVEL,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export type { Logger };
