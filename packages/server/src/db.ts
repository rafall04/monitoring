import { PrismaClient } from '@prisma/client';
import { isDev } from './env';

export const prisma = new PrismaClient({
  log: isDev ? ['warn', 'error'] : ['error'],
});

// Chunked-delete tuning. ~500-row rounds keep each DELETE statement's lock
// window short (Postgres takes a row lock per deleted row + FK cascade), and a
// small pause between rounds lets concurrent writers interleave — matters on
// giant cascades (site/router delete, retention sweeps on a year-old DB).
const DELETE_BATCH_SIZE = 500;
const DELETE_BATCH_PAUSE_MS = 50;
// Hard ceiling so a pathological caller can't loop forever: 2000 × 500 caps a
// single purge at 1M rows.
const DELETE_BATCH_MAX_ROUNDS = 2000;

/**
 * Delete rows in ~500-row chunks instead of one giant statement. Prisma's
 * deleteMany has no LIMIT, so the caller supplies a take-bounded id lookup
 * (`findIds`) plus the matching `deleteIds` (a deleteMany over those ids); each
 * round is a short transaction and a small sleep separates rounds.
 *
 * Returns the number of rows actually deleted.
 */
export async function deleteInBatches(
  findIds: (take: number) => Promise<Array<{ id: string }>>,
  deleteIds: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (let round = 0; round < DELETE_BATCH_MAX_ROUNDS; round++) {
    const rows = await findIds(DELETE_BATCH_SIZE);
    if (rows.length === 0) break;
    const res = await deleteIds(rows.map((r) => r.id));
    total += res.count;
    if (rows.length < DELETE_BATCH_SIZE) break;
    await new Promise((resolve) => setTimeout(resolve, DELETE_BATCH_PAUSE_MS));
  }
  return total;
}

export type { Prisma } from '@prisma/client';
export type {
  Company,
  Site,
  RouterMikrotik,
  Device,
  StatusEvent,
  AppUser,
  RefreshToken,
  AuditLog,
  Setting,
} from '@prisma/client';
