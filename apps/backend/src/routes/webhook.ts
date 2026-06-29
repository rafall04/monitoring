import type { FastifyInstance } from 'fastify';
import {
  applyDeviceStatusByHost,
  prisma,
  webhookIpAllowlist,
  type Logger,
} from '@noc/server';
import { netwatchWebhookSchema } from '@noc/shared';
import { forbidden, unauthorized } from '../lib/errors';

/**
 * Netwatch -> backend receiver. No JWT: authenticated by the per-router
 * X-Webhook-Token (unique secret) plus an optional IP allowlist.
 * Accepts params from the query string OR a JSON body.
 */
export async function webhookRoutes(app: FastifyInstance) {
  // RouterOS `/tool fetch http-method=post` sends Content-Type:
  // application/octet-stream (or x-www-form-urlencoded) with an empty body.
  // Fastify has no parser for those and would 415 before the handler runs. This
  // endpoint takes all of its params from the query string, so accept any body
  // type and simply drain/ignore it. (application/json keeps its built-in parser
  // for callers that POST a JSON body.) Encapsulated to this plugin.
  app.addContentTypeParser('*', (_req, payload, done) => {
    payload.resume();
    payload.on('end', () => done(null, undefined));
    payload.on('error', (err) => done(err, undefined));
  });

  // 600 req/min/IP = up to ~10 events per second from one router. A healthy
  // Netwatch with hundreds of devices wakes far below this; a stuck script
  // hot-looping (or a misconfigured allowlist) gets capped, not amplified.
  app.post('/netwatch', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (webhookIpAllowlist.length > 0 && !webhookIpAllowlist.includes(req.ip)) {
      throw forbidden('Source IP not allowed');
    }
    const token = (req.headers['x-webhook-token'] as string | undefined) ?? '';
    if (!token) throw unauthorized('Missing X-Webhook-Token');

    const router = await prisma.routerMikrotik.findUnique({ where: { webhookToken: token } });
    if (!router) throw unauthorized('Invalid webhook token');

    const q = req.query as Record<string, string | undefined>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const parsed = netwatchWebhookSchema.parse({
      host: (b.host as string) ?? q.host,
      status: (b.status as string) ?? q.status,
      routerId: router.id,
    });

    await applyDeviceStatusByHost(
      { prisma, redisPub: app.redisPub, logger: req.log as unknown as Logger },
      { routerId: router.id, host: parsed.host, status: parsed.status, source: 'webhook' },
    );

    // Receiving a webhook proves the router is alive.
    await prisma.routerMikrotik
      .update({ where: { id: router.id }, data: { status: 'online', lastSeenAt: new Date() } })
      .catch(() => undefined);

    reply.code(204);
    return null;
  });
}
