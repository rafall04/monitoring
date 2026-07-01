// =============================================================================
// Role-based access control + per-site scoping.
// This is the single source of truth used BOTH by the backend (to ENFORCE) and
// the frontend (to gate UI). Enforcement always happens server-side regardless.
// =============================================================================

import type { Role } from './types';

export const PERMISSIONS = [
  'map:view', // see the map and live status
  'device:view', // see device detail
  'device:edit-position', // drag markers / set coordinates
  'device:edit-attributes', // edit name/ip/icon/type/note/override
  'device:create', // add new devices
  'device:delete', // remove devices
  'hotspot:view', // see hotspot users / sessions
  'hotspot:manage-users', // create/edit/delete hotspot users + vouchers
  'hotspot:manage-profiles', // create/edit hotspot user-profiles
  'hotspot:disconnect', // kick active sessions
  'site:manage', // CRUD company/site/router (incl. credentials)
  'router:test', // run Test Connection
  'netwatch:manage', // generate/install Netwatch scripts, sync devices
  'appuser:manage', // CRUD app users + roles + scope
  'reports:view', // uptime/SLA reports
  'audit:view', // read audit log
  'settings:manage', // edit global branding + defaults
  'alerts:manage', // ack / silence incidents
  'ruijie:view', // see Ruijie/Reyee routers + connected-client counts
  'ruijie:manage', // add/remove Ruijie Cloud accounts (credentials)
  'firewall:view', // see access-control (block toggles + block address-lists)
  'firewall:manage', // toggle block rules + edit block lists (writes router config)
  'bandwidth:view', // see simple queues / DHCP leases / top talkers
  'bandwidth:manage', // create/edit queues + set DHCP lease rate-limit
  'device:diagnose', // run read-only diagnostics on the router (ping/traceroute/log/net-info)
  'device:remediate', // PoE power-cycle a port (writes to the router)
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Operator can ADD devices by default but NOT delete them, and cannot manage
// hotspot profiles. Tweak here if business rules change (kept static on purpose
// so the matrix is auditable in one place).
const OPERATOR_PERMISSIONS: Permission[] = [
  'map:view',
  'device:view',
  'device:edit-position',
  'device:edit-attributes',
  'device:create',
  'hotspot:view',
  'hotspot:manage-users',
  'hotspot:disconnect',
  'reports:view',
  'alerts:manage',
  'ruijie:view', // see Ruijie/Reyee WiFi monitoring (read-only)
  'firewall:view', // access-control panel
  'firewall:manage', // toggle blocks + block devices (IT technician job)
  'bandwidth:view', // bandwidth/QoS panel
  'bandwidth:manage', // set queues + DHCP lease rate-limit
  'device:diagnose', // ping/traceroute/log from the router (IT technician job)
  'device:remediate', // PoE power-cycle a frozen device
];

// Viewer = read-only monitor: the map + device detail, Ruijie WiFi monitoring,
// and the reports/alerts pages — but NO mutations. Operator+ adds the write
// actions; account/credential management stays super_admin-only.
const VIEWER_PERMISSIONS: Permission[] = [
  'map:view',
  'device:view',
  'ruijie:view',
  'reports:view',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER_PERMISSIONS,
  operator: OPERATOR_PERMISSIONS,
  super_admin: PERMISSIONS, // everything
};

export function hasPermission(role: Role, permission: Permission): boolean {
  // Defensive `?? []`: a stale/unknown role (e.g. an old session from before a
  // role rename) yields no permissions instead of throwing.
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/** Minimal user shape needed for authorization decisions. */
export interface ScopedUser {
  role: Role;
  scopeSiteIds: string[];
}

/** super_admin sees every site; others only their assigned sites. */
export function canAccessSite(user: ScopedUser, siteId: string): boolean {
  if (user.role === 'super_admin') return true;
  return user.scopeSiteIds.includes(siteId);
}

/**
 * Returns a filter descriptor for list queries. `null` means "no restriction"
 * (super_admin); otherwise an explicit list of site ids the user may read.
 */
export function siteScopeFor(user: ScopedUser): string[] | null {
  if (user.role === 'super_admin') return null;
  return user.scopeSiteIds;
}

/** Convenience: does the user have the permission AND access to the site? */
export function can(
  user: ScopedUser,
  permission: Permission,
  siteId?: string,
): boolean {
  if (!hasPermission(user.role, permission)) return false;
  if (siteId !== undefined && !canAccessSite(user, siteId)) return false;
  return true;
}
