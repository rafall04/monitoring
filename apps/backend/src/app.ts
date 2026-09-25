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

/**
 * Parse TRUST_PROXY into a Fastify-compatible value:
 * 'true'/'false' -> boolean, digits -> hop count, otherwise a comma-separated
 * list of trusted proxy IPs/CIDRs. Default 'false': the backend port is usually
 * published on the host, and trusting XFF from any peer makes client-IP-based
 * controls (rate limits, webhook allowlist) spoofable.
 */
function parseTrustProxy(raw: string): boolean | number | string[] {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    bodyLimit: 1_048_576,
    // Cap wedged connections (e.g. a dead upstream hanging a proxied request)
    // so sockets can't pile up forever.
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
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
    // Fail closed: an empty whitelist must NOT reflect arbitrary origins.
    // (Same-origin traffic via the frontend proxy never needs CORS anyway.)
    origin: corsOrigins.length > 0 ? corsOrigins : false,
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
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/uploads/',
    setHeaders: (res, filePath) => {
      // Uploads are user content served from our origin: never sniff MIME, and
      // strip scripting ability. SVGs get the strictest policy — an uploaded
      // SVG executing same-origin JS could steal the localStorage auth token.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Security-Policy',
        filePath.endsWith('.svg') ? "default-src 'none'" : 'sandbox',
      );
    },
  });

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

  app.get('/', async () => ({ name: 'RAF NOC API', version: '0.1.0' }));

  await app.register(apiRoutes, { prefix: '/api/v1' });
  await registerWebsocketHub(app);

  app.addHook('onClose', async () => {
    await redisPub.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  });

  return app;
}
