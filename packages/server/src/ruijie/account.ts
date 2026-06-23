import { decryptSecret } from '../crypto';
import { prisma } from '../db';
import { RuijieCloudClient } from './cloud';
import type { RuijieClient } from './types';
import type { RuijieProjectDTO } from '@noc/shared';

/** Just the creds needed to build a client. A RuijieAccount row satisfies it. */
interface ClientCreds {
  appId: string;
  appSecretEncrypted: string;
  baseUrl: string;
}

/** A pollable account: creds + the monitor allowlist (which groups to track). */
interface PollableAccount extends ClientCreds {
  id: string;
  monitoredGroupIds: string[];
}

/** Build a read-only Ruijie client from an account row (decrypts the secret). */
export function ruijieClientForAccount(a: ClientCreds): RuijieClient {
  return new RuijieCloudClient({
    driver: 'cloud',
    appId: a.appId,
    appSecret: decryptSecret(a.appSecretEncrypted),
    baseUrl: a.baseUrl,
  });
}

export interface RuijiePollResult {
  ok: boolean;
  devices: number;
  online: number;
  totalClients: number;
  error?: string;
}

/**
 * Poll one Ruijie account: fetch the whole fleet in ONE call, keep only the
 * devices in the account's monitored groups (the allowlist — so the owner's
 * non-NOC sites never reach our DB), and upsert each kept device's status +
 * connected-client count into `ruijie_router`. Rows for de-selected groups are
 * pruned. Read-only against Ruijie — the only writes are to our own DB.
 */
export async function pollRuijieAccount(account: PollableAccount): Promise<RuijiePollResult> {
  const client = ruijieClientForAccount(account);
  try {
    const allDevices = await client.getDevices();
    const allow = new Set(account.monitoredGroupIds.map(String));
    // Empty allowlist = monitor nothing (the admin hasn't picked any project yet).
    const devices = allow.size > 0 ? allDevices.filter((d) => allow.has(String(d.groupId))) : [];

    let online = 0;
    let totalClients = 0;
    for (const d of devices) {
      if (d.online) online += 1;
      totalClients += d.clientCount;
      const fields = {
        cloudGroupId: String(d.groupId),
        groupName: d.groupName,
        name: d.name,
        model: d.model,
        online: d.online,
        clientCount: d.clientCount,
        activeClients: d.activeClients,
        localIp: d.localIp,
        wanIp: d.wanIp,
        mac: d.mac,
        firmware: d.firmware,
        // keep the last-seen timestamp when a router goes offline
        lastSeenAt: d.online ? new Date() : undefined,
      };
      await prisma.ruijieRouter.upsert({
        where: { accountId_cloudSerial: { accountId: account.id, cloudSerial: d.serial } },
        create: { accountId: account.id, cloudSerial: d.serial, ...fields },
        update: fields,
      });
    }
    // Drop routers whose group is no longer monitored (allowlist shrank, or was
    // never set). With an empty allowlist `in: []` matches nothing, so NOT-in
    // matches everything → all of this account's routers are removed.
    await prisma.ruijieRouter.deleteMany({
      where: { accountId: account.id, NOT: { cloudGroupId: { in: [...allow] } } },
    });
    await prisma.ruijieAccount.update({
      where: { id: account.id },
      data: { lastPolledAt: new Date(), lastError: null },
    });
    return { ok: true, devices: devices.length, online, totalClients };
  } catch (e) {
    const error = (e as Error).message;
    await prisma.ruijieAccount
      .update({ where: { id: account.id }, data: { lastPolledAt: new Date(), lastError: error } })
      .catch(() => undefined);
    return { ok: false, devices: 0, online: 0, totalClients: 0, error };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Live-discover every project/group in the account (one read-only fleet call),
 * with per-group device/online/client tallies and a `monitored` flag from the
 * current allowlist. Powers the super_admin's "which projects to monitor" picker
 * — they tick the school groups and ignore the personal/factory ones.
 */
export async function discoverRuijieProjects(account: PollableAccount): Promise<RuijieProjectDTO[]> {
  const client = ruijieClientForAccount(account);
  try {
    const devices = await client.getDevices();
    const allow = new Set(account.monitoredGroupIds.map(String));
    const byGroup = new Map<string, RuijieProjectDTO>();
    for (const d of devices) {
      const groupId = String(d.groupId);
      let p = byGroup.get(groupId);
      if (!p) {
        p = {
          groupId,
          groupName: d.groupName || '(tanpa grup)',
          deviceCount: 0,
          onlineCount: 0,
          clientCount: 0,
          monitored: allow.has(groupId),
        };
        byGroup.set(groupId, p);
      }
      p.deviceCount += 1;
      if (d.online) p.onlineCount += 1;
      p.clientCount += d.clientCount;
    }
    return [...byGroup.values()].sort((a, b) => a.groupName.localeCompare(b.groupName));
  } finally {
    await client.close().catch(() => undefined);
  }
}
