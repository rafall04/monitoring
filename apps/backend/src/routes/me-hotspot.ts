import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clientForRouter,
  getMemberStatus,
  hashPassword,
  kickMemberSessions,
  prisma,
  setMemberPassword,
} from '@noc/server';
import {
  hotspotKickSchema,
  hotspotSelfPasswordSchema,
} from '@noc/shared';
import { writeAudit } from '../lib/audit';
import { badGateway, badRequest, notFound } from '../lib/errors';
import { authenticate } from '../plugins/auth';
import type { RouterMikrotik, AppUser } from '@noc/server';

/**
 * Member self-service: a logged-in AppUser with a hotspot link
 * (hotspotRouterId + hotspotUsername) manages ONLY that hotspot account —
 * status, own password, own sessions. Authorization here is the link itself,
 * not the RBAC matrix (members carry zero permissions).
 */
async function linkedAccount(
  req: FastifyRequest,
): Promise<{ me: AppUser; router: RouterMikrotik }> {
  const me = await prisma.appUser.findUnique({ where: { id: req.appUser.id } });
  if (!me?.hotspotRouterId || !me.hotspotUsername) {
    throw notFound('Akun ini tidak tertaut ke akun hotspot manapun');
  }
  const router = await prisma.routerMikrotik.findUnique({
    where: { id: me.hotspotRouterId },
  });
  if (!router) throw notFound('Router hotspot tidak ditemukan');
  return { me, router };
}

export async function meHotspotRoutes(app: FastifyInstance) {
  const guard = { onRequest: [authenticate] };

  // Own account status: profile, device limit, quota usage, blocked apps,
  // active sessions — everything read live from the linked router.
  app.get('/', guard, async (req) => {
    const { me, router } = await linkedAccount(req);
    const c = clientForRouter(router);
    try {
      const out = await getMemberStatus(c, me.hotspotUsername!);
      if (!out) throw notFound('User hotspot tidak ditemukan di router');
      return out;
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
    } finally {
      await c.close();
    }
  });

  // Change own hotspot password: verified against the router's stored
  // password, then written to BOTH the router and the member's app login
  // (same credential) — and every refresh token revoked so other devices must
  // sign back in with the new one.
  app.post(
    '/password',
    {
      ...guard,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = hotspotSelfPasswordSchema.parse(req.body);
      const { me, router } = await linkedAccount(req);
      const c = clientForRouter(router);
      try {
        const res = await setMemberPassword(
          c,
          me.hotspotUsername!,
          body.currentPassword,
          body.newPassword,
        );
        if (res === 'not-found') throw notFound('User hotspot tidak ditemukan di router');
        if (res === 'wrong-password') throw badRequest('Password lama salah');
      } catch (err) {
        if (err && typeof err === 'object' && 'statusCode' in err) throw err;
        throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
      } finally {
        await c.close();
      }
      await prisma.appUser.update({
        where: { id: me.id },
        data: { passwordHash: await hashPassword(body.newPassword) },
      });
      await prisma.refreshToken.updateMany({
        where: { userId: me.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await writeAudit(req, {
        action: 'hotspot-self-password',
        entity: 'app_user',
        entityId: me.id,
        after: { hotspotUsername: me.hotspotUsername },
      });
      return { ok: true };
    },
  );

  // Kick own session(s): solves the "already logged in on another device"
  // lockout without waiting for an operator.
  app.post('/kick', guard, async (req) => {
    const body = hotspotKickSchema.parse(req.body ?? {});
    const { me, router } = await linkedAccount(req);
    const c = clientForRouter(router);
    try {
      const { kicked } = await kickMemberSessions(c, me.hotspotUsername!, body.id);
      if (body.id && kicked === 0) throw notFound('Sesi tidak ditemukan');
      await writeAudit(req, {
        action: 'hotspot-self-kick',
        entity: 'app_user',
        entityId: me.id,
        after: { kicked },
      });
      return { kicked };
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
    } finally {
      await c.close();
    }
  });
}
