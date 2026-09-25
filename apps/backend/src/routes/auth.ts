import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import {
  env,
  generateToken,
  hashPassword,
  prisma,
  sha256,
  toAppUserPublic,
  type AppUser,
} from '@noc/server';
import { changePasswordSchema, loginSchema, refreshSchema, updateProfileSchema } from '@noc/shared';
import { writeAudit } from '../lib/audit';
import { badRequest, unauthorized } from '../lib/errors';
import { durationToSeconds } from '../lib/time';
import { authenticate } from '../plugins/auth';

// Fixed bcrypt hash for a dummy compare when the account is unknown/inactive —
// keeps login response time identical so it can't serve as an email oracle.
// Cost matches BCRYPT_COST (12) so a "real" account isn't distinguishable by
// a slower compare.
const DUMMY_PASSWORD_HASH = '$2a$12$lFCTna.BfC9LB0/uaE40DOZTkv/0hHfXEz2/FMMw2RVSyNOskbrmi';

async function issueTokens(app: FastifyInstance, user: AppUser) {
  const accessToken = app.jwt.sign({
    sub: user.id,
    role: user.role as never,
    name: user.name,
    email: user.email,
  });
  const refreshToken = generateToken(48);
  const expiresAt = new Date(
    Date.now() + durationToSeconds(env.JWT_REFRESH_TTL) * 1000,
  );
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt },
  });
  return { accessToken, refreshToken };
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { email, password } = loginSchema.parse(req.body);
      const user = await prisma.appUser.findUnique({ where: { email } });
      // Always run a bcrypt compare — even for unknown/inactive accounts — so
      // response timing can't reveal whether the email is registered.
      const ok = await bcrypt.compare(
        password,
        user && user.isActive ? user.passwordHash : DUMMY_PASSWORD_HASH,
      );
      if (!user || !user.isActive || !ok) {
        await writeAudit(req, {
          action: 'login-failed',
          entity: 'app_user',
          entityId: user?.id ?? null,
          after: { email },
        });
        throw unauthorized('Invalid credentials');
      }
      const tokens = await issueTokens(app, user);
      await writeAudit(req, { action: 'login', entity: 'app_user', entityId: user.id });
      return { user: toAppUserPublic(user), ...tokens };
    },
  );

  app.post(
    '/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const { refreshToken } = refreshSchema.parse(req.body);
      const tokenHash = sha256(refreshToken);
      const now = new Date();

      const result = await prisma.$transaction(async (tx) => {
        // Atomic rotation: this conditional UPDATE is the concurrency guard —
        // it only fires while the token is still live. count === 0 means the
        // token was already consumed (REUSE) or never existed.
        const rotated = await tx.refreshToken.updateMany({
          where: { tokenHash, revokedAt: null },
          data: { revokedAt: now },
        });
        const row = await tx.refreshToken.findUnique({ where: { tokenHash } });
        if (rotated.count === 0) {
          // Reuse of an already-rotated token can mean theft: revoke the ENTIRE
          // session family so the legitimate user's next refresh also fails
          // and forces a fresh login.
          if (row) {
            await tx.refreshToken.updateMany({
              where: { userId: row.userId, revokedAt: null },
              data: { revokedAt: now },
            });
          }
          return { ok: false as const, reason: 'invalid' as const };
        }
        if (!row || row.expiresAt < now) {
          return { ok: false as const, reason: 'invalid' as const };
        }
        const user = await tx.appUser.findUnique({ where: { id: row.userId } });
        if (!user || !user.isActive) {
          return { ok: false as const, reason: 'inactive' as const };
        }
        const accessToken = app.jwt.sign({
          sub: user.id,
          role: user.role as never,
          name: user.name,
          email: user.email,
        });
        const nextRefreshToken = generateToken(48);
        const expiresAt = new Date(
          Date.now() + durationToSeconds(env.JWT_REFRESH_TTL) * 1000,
        );
        await tx.refreshToken.create({
          data: { userId: user.id, tokenHash: sha256(nextRefreshToken), expiresAt },
        });
        return { ok: true as const, user, accessToken, refreshToken: nextRefreshToken };
      });

      if (!result.ok) {
        throw unauthorized(
          result.reason === 'inactive' ? 'Account inactive' : 'Invalid refresh token',
        );
      }
      return {
        user: toAppUserPublic(result.user),
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    },
  );

  app.post('/logout', async (req) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (parsed.success) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: sha256(parsed.data.refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true };
  });

  app.get('/me', { onRequest: [authenticate] }, async (req) => {
    const u = await prisma.appUser.findUnique({ where: { id: req.appUser.id } });
    if (!u) throw unauthorized();
    return toAppUserPublic(u);
  });

  // Self-service profile edit (name + department). Email + role + scope are
  // managed via the admin user endpoints to prevent privilege/lockout abuse.
  app.patch('/me', { onRequest: [authenticate] }, async (req) => {
    const body = updateProfileSchema.parse(req.body);
    const u = await prisma.appUser.update({
      where: { id: req.appUser.id },
      data: {
        name: body.name,
        // undefined = leave as-is; ''/null = clear; string = set.
        ...(body.department !== undefined
          ? { department: body.department?.trim() || null }
          : {}),
      },
    });
    await writeAudit(req, { action: 'profile-update', entity: 'app_user', entityId: u.id, after: { name: u.name, department: u.department } });
    return toAppUserPublic(u);
  });

  // Self-service password change. Rate-limited like login. Verifies the
  // current password before accepting the new one, and revokes every existing
  // refresh token so other sessions must sign back in — except the token the
  // client optionally posts as `refreshToken`, which survives.
  app.post(
    '/change-password',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = changePasswordSchema.parse(req.body);
      const u = await prisma.appUser.findUnique({ where: { id: req.appUser.id } });
      if (!u) throw unauthorized();
      const ok = await bcrypt.compare(body.currentPassword, u.passwordHash);
      if (!ok) throw badRequest('Password sekarang tidak cocok');
      const passwordHash = await hashPassword(body.newPassword);
      await prisma.appUser.update({ where: { id: u.id }, data: { passwordHash } });
      // Revoke every session — except the one the client just proved it holds
      // by posting its current refresh token, which keeps this session alive.
      const keepHash = body.refreshToken ? sha256(body.refreshToken) : null;
      await prisma.refreshToken.updateMany({
        where: {
          userId: u.id,
          revokedAt: null,
          ...(keepHash ? { tokenHash: { not: keepHash } } : {}),
        },
        data: { revokedAt: new Date() },
      });
      await writeAudit(req, { action: 'password-change', entity: 'app_user', entityId: u.id });
      return { ok: true };
    },
  );
}
