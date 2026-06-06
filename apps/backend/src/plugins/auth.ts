import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@noc/shared';
import { prisma } from '@noc/server';
import { unauthorized } from '../lib/errors';

export interface AppUserCtx {
  id: string;
  role: Role;
  scopeSiteIds: string[];
  name: string;
  email: string;
}

interface JwtPayload {
  sub: string;
  role: Role;
  name: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    appUser: AppUserCtx;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

/**
 * onRequest hook: verifies the access JWT and loads a fresh user snapshot so
 * role/scope/active changes take effect immediately (no stale tokens).
 */
export async function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const sub = request.user.sub;
  const u = await prisma.appUser.findUnique({ where: { id: sub } });
  if (!u || !u.isActive) throw unauthorized('Account inactive or not found');

  request.appUser = {
    id: u.id,
    role: u.role as Role,
    scopeSiteIds: (u.scopeSiteIds as string[] | null) ?? [],
    name: u.name,
    email: u.email,
  };
}
