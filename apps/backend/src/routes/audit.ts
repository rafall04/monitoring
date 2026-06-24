import type { FastifyInstance } from 'fastify';
import { prisma, toAuditLogPublic } from '@noc/server';
import { auditQuerySchema } from '@noc/shared';
import { authenticate, requirePermission } from '../plugins/rbac';

// Read-only audit-trail viewer (super_admin / audit:view). Every sensitive
// mutation across the app already calls writeAudit(); this exposes that history
// with the acting user joined, plus entity/action filters + pagination.
export async function auditRoutes(app: FastifyInstance) {
  app.get(
    '/',
    { onRequest: [authenticate], preHandler: [requirePermission('audit:view')] },
    async (req) => {
      const q = auditQuerySchema.parse(req.query);
      const where = {
        ...(q.action ? { action: q.action } : {}),
        ...(q.entity ? { entity: q.entity } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
      };
      const [rows, total, entities, actions] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          include: { user: true },
          orderBy: { createdAt: 'desc' },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          distinct: ['entity'],
          select: { entity: true },
          orderBy: { entity: 'asc' },
        }),
        prisma.auditLog.findMany({
          distinct: ['action'],
          select: { action: true },
          orderBy: { action: 'asc' },
        }),
      ]);
      return {
        items: rows.map(toAuditLogPublic),
        total,
        page: q.page,
        pageSize: q.pageSize,
        facets: {
          entities: entities.map((e) => e.entity),
          actions: actions.map((a) => a.action),
        },
      };
    },
  );
}
