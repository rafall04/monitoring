// =============================================================================
// Baileys auth state backed by the wa_auth_key table (AES-256-GCM per value).
// Baileys' stock useMultiFileAuthState writes creds + signal keys as files —
// here they live encrypted in Postgres, so a container rebuild never forces a
// re-pair and session keys never sit on a volume in plaintext.
// =============================================================================

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
} from '@whiskeysockets/baileys';
import { decryptSecret, encryptSecret, prisma } from '@noc/server';

async function read(key: string): Promise<unknown> {
  try {
    const row = await prisma.waAuthKey.findUnique({ where: { key } });
    if (!row) return null;
    return JSON.parse(decryptSecret(row.valueEnc), BufferJSON.reviver);
  } catch {
    // Reference parity: a corrupt/undecryptable row is treated as absent —
    // propagating here would poison every socket connect into a stall.
    return null;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  const valueEnc = encryptSecret(JSON.stringify(value, BufferJSON.replacer));
  await prisma.waAuthKey.upsert({ where: { key }, update: { valueEnc }, create: { key, valueEnc } });
}

async function remove(key: string): Promise<void> {
  await prisma.waAuthKey.delete({ where: { key } }).catch(() => undefined);
}

/** Drop every key — used after a loggedOut so the next socket pairs fresh. */
export async function clearDbAuthState(): Promise<void> {
  await prisma.waAuthKey.deleteMany();
}

export async function useDbAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const creds = ((await read('creds')) as AuthenticationCreds | null) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data: Record<string, unknown> = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            // app-state-sync-key must come back as a proto instance, not a POJO.
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) data[id] = value;
          }),
        );
        return data as never;
      },
      set: async (data) => {
        const tasks: Promise<void>[] = [];
        for (const [type, ids] of Object.entries(data)) {
          for (const [id, value] of Object.entries(ids ?? {})) {
            tasks.push(value ? write(`${type}-${id}`, value) : remove(`${type}-${id}`));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return { state, saveCreds: () => write('creds', creds) };
}
