import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clientForRouter, prisma } from '@noc/server';
import {
  BLOCK_SERVICES,
  hotspotKickSchema,
  hotspotSelfPasswordSchema,
  type MemberHotspotStatus,
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
      const u = await c.getHotspotUserByName(me.hotspotUsername!);
      if (!u) throw notFound('User hotspot tidak ditemukan di router');
      const [profs, active, intents] = await Promise.all([
        c.listHotspotProfiles(),
        c.listHotspotActive(),
        c.listBlockIntents(),
      ]);
      // Device limit comes from the user-PROFILE (variant-aware); blocked apps
      // follow the BASE profile's group since -ND variants share its noc-grp.
      const base = (u.profile || 'default').replace(/-\d+D$/, '');
      const devices = Number(
        profs.find((p) => p.name === u.profile)?.['shared-users'] ?? 1,
      );
      const blockedServices = intents
        .filter((i) => i.group === base && i.active)
        .map((i) => ({
          key: i.service,
          label: BLOCK_SERVICES.find((s) => s.key === i.service)?.label ?? i.service,
        }));
      const out: MemberHotspotStatus = {
        username: u.name,
        profile: u.profile ?? 'default',
        devices: Number.isFinite(devices) ? devices : 1,
        disabled: u.disabled === 'true',
        uptime: u.uptime ?? null,
        bytesIn: u['bytes-in'] ?? null,
        bytesOut: u['bytes-out'] ?? null,
        limitUptime: u['limit-uptime'] ?? null,
        limitBytesTotal: u['limit-bytes-total'] ?? null,
        blockedServices,
        sessions: active.filter((s) => s.user === u.name),
      };
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
        const u = await c.getHotspotUserByName(me.hotspotUsername!);
        if (!u?.['.id']) throw notFound('User hotspot tidak ditemukan di router');
        if ((u.password ?? '') !== body.currentPassword) {
          throw badRequest('Password lama salah');
        }
        await c.updateHotspotUser(u['.id'], { password: body.newPassword });
      } catch (err) {
        if (err && typeof err === 'object' && 'statusCode' in err) throw err;
        throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
      } finally {
        await c.close();
      }
      await prisma.appUser.update({
        where: { id: me.id },
        data: { passwordHash: await bcrypt.hash(body.newPassword, 10) },
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
      const active = await c.listHotspotActive();
      const mine = active.filter((s) => s.user === me.hotspotUsername);
      const targets = body.id ? mine.filter((s) => s['.id'] === body.id) : mine;
      if (body.id && targets.length === 0) throw notFound('Sesi tidak ditemukan');
      for (const s of targets) {
        if (s['.id']) await c.disconnectHotspotActive(s['.id']);
      }
      await writeAudit(req, {
        action: 'hotspot-self-kick',
        entity: 'app_user',
        entityId: me.id,
        after: { kicked: targets.length },
      });
      return { kicked: targets.length };
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      throw badGateway(`MikroTik error: ${(err as Error)?.message ?? err}`);
    } finally {
      await c.close();
    }
  });
}
