import { decryptSecret } from '../crypto';
import { prisma } from '../db';
import { RuijieCloudClient } from './cloud';
import type { RuijieClient } from './types';

/** Just the fields needed to build/poll a client — a RuijieAccount row satisfies it. */
interface AccountCreds {
  id: string;
  appId: string;
  appSecretEncrypted: string;
  baseUrl: string;
}

/** Build a read-only Ruijie client from an account row (decrypts the secret). */
export function ruijieClientForAccount(a: AccountCreds): RuijieClient {
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
 * Poll one Ruijie account: fetch the whole fleet in ONE call and upsert each
 * device's online status + connected-client count into `ruijie_router`. Records
 * lastPolledAt / lastError on the account. Read-only against Ruijie — the only
 * writes are to our own DB.
 */
export async function pollRuijieAccount(account: AccountCreds): Promise<RuijiePollResult> {
  const client = ruijieClientForAccount(account);
  try {
    const devices = await client.getDevices();
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
