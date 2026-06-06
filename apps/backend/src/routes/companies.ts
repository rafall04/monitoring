import type { FastifyInstance } from 'fastify';
import { prisma, toCompanyDto } from '@noc/server';
import {
  createCompanySchema,
  idParamSchema,
  updateCompanySchema,
} from '@noc/shared';
import { notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, requirePermission } from '../plugins/rbac';

// Company management is super_admin only (gated by the 'site:manage' permission).
export async function companyRoutes(app: FastifyInstance) {
  const guard = {
    onRequest: [authenticate],
    preHandler: [requirePermission('site:manage')],
  };

  app.get('/', guard, async () => {
    const rows = await prisma.company.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toCompanyDto);
  });

  app.post('/', guard, async (req) => {
    const body = createCompanySchema.parse(req.body);
    const c = await prisma.company.create({ data: { name: body.name } });
    await writeAudit(req, { action: 'create', entity: 'company', entityId: c.id, after: c });
    return toCompanyDto(c);
  });

  app.patch('/:id', guard, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const body = updateCompanySchema.parse(req.body);
    const before = await prisma.company.findUnique({ where: { id } });
    if (!before) throw notFound('Company not found');
    const c = await prisma.company.update({ where: { id }, data: body });
    await writeAudit(req, { action: 'update', entity: 'company', entityId: id, before, after: c });
    return toCompanyDto(c);
  });

  app.delete('/:id', guard, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const before = await prisma.company.findUnique({ where: { id } });
    if (!before) throw notFound('Company not found');
    await prisma.company.delete({ where: { id } });
    await writeAudit(req, { action: 'delete', entity: 'company', entityId: id, before });
    reply.code(204);
    return null;
  });
}
