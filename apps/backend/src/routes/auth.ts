import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import {
  env,
  generateToken,
  prisma,
  sha256,
  toAppUserPublic,
  type AppUser,
} from '@noc/server';
import { loginSchema, refreshSchema } from '@noc/shared';
import { unauthorized } from '../lib/errors';
import { durationToSeconds } from '../lib/time';
import { authenticate } from '../plugins/auth';

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
      if (!user || !user.isActive) throw unauthorized('Invalid credentials');
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) throw unauthorized('Invalid credentials');
      const tokens = await issueTokens(app, user);
      return { user: toAppUserPublic(user), ...tokens };
    },
  );

  app.post('/refresh', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw unauthorized('Invalid refresh token');
    }
    const user = await prisma.appUser.findUnique({ where: { id: row.userId } });
    if (!user || !user.isActive) throw unauthorized('Account inactive');
    // rotation: revoke the used token, issue a fresh pair
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    const tokens = await issueTokens(app, user);
    return { user: toAppUserPublic(user), ...tokens };
  });

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
}
