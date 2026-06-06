import type { FastifyRequest } from 'fastify';
import { prisma } from '@noc/server';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Best-effort audit write for sensitive actions. Never throws into the request. */
export async function writeAudit(req: FastifyRequest, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req.appUser?.id ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: (entry.before as object | undefined) ?? undefined,
        after: (entry.after as object | undefined) ?? undefined,
        ip: req.ip,
      },
    });
  } catch (err) {
    req.log.warn({ err }, 'audit write failed');
  }
}
