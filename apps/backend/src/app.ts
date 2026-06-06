import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import {
  corsOrigins,
  createRedis,
  env,
  isDev,
  prisma,
  type Redis,
} from '@noc/server';
import { HttpError } from './lib/errors';
import { apiRoutes } from './routes';
import { registerWebsocketHub } from './ws/hub';

declare module 'fastify' {
  interface FastifyInstance {
    redisPub: Redis;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: true,
    bodyLimit: 1_048_576,
    logger: {
      level: env.LOG_LEVEL,
      ...(isDev
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
  });

  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });
  await app.register(jwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  });

  const uploadDir = resolve(env.UPLOAD_DIR);
  await mkdir(uploadDir, { recursive: true });
  await app.register(fastifyStatic, { root: uploadDir, prefix: '/uploads/' });

  app.decorateRequest('appUser', null);
  const redisPub = createRedis('backend-pub');
  app.decorate('redisPub', redisPub);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send({ error: 'ValidationError', issues: err.issues });
      return;
    }
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ error: err.name, message: err.message });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    reply.code(status).send({
      error: err.name ?? 'Error',
      message: status >= 500 ? 'Internal Server Error' : err.message,
    });
  });

  app.get('/health', async (_req, reply) => {
    const checks = { db: false, redis: false };
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = true;
    } catch {
      /* db down */
    }
    try {
      checks.redis = (await redisPub.ping()) === 'PONG';
    } catch {
      /* redis down */
    }
    const ok = checks.db && checks.redis;
    if (!ok) reply.code(503);
    return { status: ok ? 'ok' : 'degraded', checks };
  });

  app.get('/', async () => ({ name: 'MikroTik NOC API', version: '0.1.0' }));

  await app.register(apiRoutes, { prefix: '/api/v1' });
  await registerWebsocketHub(app);

  app.addHook('onClose', async () => {
    await redisPub.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  });

  return app;
}
