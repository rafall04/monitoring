import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { prisma, toAppUserPublic } from '@noc/server';
import {
  createAppUserSchema,
  idParamSchema,
  updateAppUserSchema,
} from '@noc/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, requirePermission } from '../plugins/rbac';

// App user + role + scope management: super_admin only ('appuser:manage').
export async function userRoutes(app: FastifyInstance) {
  const guard = { onRequest: [authenticate], preHandler: [requirePermission('appuser:manage')] };

  app.get('/', guard, async () => {
    const rows = await prisma.appUser.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toAppUserPublic);
  });

  app.post('/', guard, async (req) => {
    const body = createAppUserSchema.parse(req.body);
    const exists = await prisma.appUser.findUnique({ where: { email: body.email } });
    if (exists) throw conflict('Email already in use');
    const u = await prisma.appUser.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 10),
        role: body.role,
        scopeSiteIds: body.scopeSiteIds,
        isActive: body.isActive,
      },
    });
    await writeAudit(req, { action: 'create', entity: 'app_user', entityId: u.id, after: toAppUserPublic(u) });
    return toAppUserPublic(u);
  });

  app.patch('/:id', guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateAppUserSchema.parse(req.body);
    const before = await prisma.appUser.findUnique({ where: { id } });
    if (!before) throw notFound('User not found');

    const { password, ...rest } = body;
    const u = await prisma.appUser.update({
      where: { id },
      data: {
        ...rest,
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      },
    });
    await writeAudit(req, {
      action: 'update',
      entity: 'app_user',
      entityId: id,
      before: toAppUserPublic(before),
      after: toAppUserPublic(u),
    });
    return toAppUserPublic(u);
  });

  app.delete('/:id', guard, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    if (id === req.appUser.id) throw badRequest('You cannot delete your own account');
    const before = await prisma.appUser.findUnique({ where: { id } });
    if (!before) throw notFound('User not found');
    await prisma.appUser.delete({ where: { id } });
    await writeAudit(req, { action: 'delete', entity: 'app_user', entityId: id, before: toAppUserPublic(before) });
    reply.code(204);
    return null;
  });
}
