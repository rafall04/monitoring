import { PrismaClient } from '@prisma/client';
import { isDev } from './env';

export const prisma = new PrismaClient({
  log: isDev ? ['warn', 'error'] : ['error'],
});

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
