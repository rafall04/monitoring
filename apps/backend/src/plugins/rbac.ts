import type { FastifyRequest } from 'fastify';
import {
  canAccessSite,
  hasPermission,
  siteScopeFor,
  type Permission,
} from '@noc/shared';
import { forbidden } from '../lib/errors';
import { authenticate, type AppUserCtx } from './auth';

/**
 * Compose the guards for a route: authenticate first, then check the permission.
 * Site-level access is checked inside handlers via assertSiteAccess() once the
 * target resource's siteId is known.
 *
 *   app.post('/sites', { onRequest: [authenticate], preHandler: [requirePermission('site:manage')] }, ...)
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!hasPermission(request.appUser.role, permission)) {
      throw forbidden(`Missing permission: ${permission}`);
    }
  };
}

export function assertSiteAccess(user: AppUserCtx, siteId: string): void {
  if (!canAccessSite(user, siteId)) {
    throw forbidden('No access to this site');
  }
}

/**
 * Prisma `where` fragment that restricts list queries to the user's sites.
 * Returns {} for super_admin (no restriction).
 */
export function siteScopeWhere(user: AppUserCtx): { siteId?: { in: string[] } } {
  const scope = siteScopeFor(user);
  return scope === null ? {} : { siteId: { in: scope } };
}

export { authenticate };
