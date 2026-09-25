// =============================================================================
// Member hotspot operations — the shared core behind the /me/hotspot REST
// endpoints AND the WhatsApp bot member commands. Kept free of Fastify/HTTP
// concerns: functions take an open MikrotikClient and return neutral results;
// callers translate them (HTTP errors for REST, text replies for the bot).
// =============================================================================

import { BLOCK_SERVICES, type MemberHotspotStatus } from '@noc/shared';
import type { MikrotikClient } from './mikrotik/types';

/** Own-account status: profile, device limit, quota usage, blocks, sessions. */
export async function getMemberStatus(
  c: MikrotikClient,
  username: string,
): Promise<MemberHotspotStatus | null> {
  const u = await c.getHotspotUserByName(username);
  if (!u) return null;
  const [profs, active, intents] = await Promise.all([
    c.listHotspotProfiles(),
    c.listHotspotActive(),
    c.listBlockIntents(),
  ]);
  // Device limit comes from the user-PROFILE (variant-aware); blocked apps
  // follow the BASE profile's group since -ND variants share its noc-grp.
  const base = (u.profile || 'default').replace(/-\d+D$/, '');
  const devices = Number(profs.find((p) => p.name === u.profile)?.['shared-users'] ?? 1);
  const blockedServices = intents
    .filter((i) => i.group === base && i.active)
    .map((i) => ({
      key: i.service,
      label: BLOCK_SERVICES.find((s) => s.key === i.service)?.label ?? i.service,
    }));
  return {
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
}

/** Disconnect the member's own active session(s). `onlyId` targets one. */
export async function kickMemberSessions(
  c: MikrotikClient,
  username: string,
  onlyId?: string,
): Promise<{ kicked: number; matched: number }> {
  const active = await c.listHotspotActive();
  const mine = active.filter((s) => s.user === username);
  const targets = onlyId ? mine.filter((s) => s['.id'] === onlyId) : mine;
  for (const s of targets) {
    if (s['.id']) await c.disconnectHotspotActive(s['.id']);
  }
  return { kicked: targets.length, matched: mine.length };
}

export type PasswordChangeResult = 'ok' | 'not-found' | 'wrong-password';

/** Change the hotspot password on the router (verified against the stored one). */
export async function setMemberPassword(
  c: MikrotikClient,
  username: string,
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeResult> {
  const u = await c.getHotspotUserByName(username);
  if (!u?.['.id']) return 'not-found';
  if ((u.password ?? '') !== currentPassword) return 'wrong-password';
  await c.updateHotspotUser(u['.id'], { password: newPassword });
  return 'ok';
}
