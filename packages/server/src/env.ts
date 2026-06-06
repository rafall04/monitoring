// =============================================================================
// Centralised, validated environment for node services (backend + worker).
// Loads the nearest .env walking up from CWD so it works whether you run from
// the repo root or from inside a workspace dir.
// =============================================================================

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadDotenv();

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  BACKEND_HOST: z.string().default('0.0.0.0'),
  BACKEND_PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  WORKER_HEALTH_PORT: z.coerce.number().int().default(4100),
  POLL_INTERVAL_DEFAULT_SEC: z.coerce.number().int().default(20),
  RECONCILE_INTERVAL_SEC: z.coerce.number().int().default(300),
  WORKER_SHARD_COUNT: z.coerce.number().int().min(1).default(1),
  WORKER_SHARD_INDEX: z.coerce.number().int().min(0).default(0),

  JWT_ACCESS_SECRET: z.string().min(8, 'JWT_ACCESS_SECRET too short'),
  JWT_REFRESH_SECRET: z.string().min(8, 'JWT_REFRESH_SECRET too short'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  CREDENTIALS_ENC_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'CREDENTIALS_ENC_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)'),

  WEBHOOK_IP_ALLOWLIST: z.string().default(''),

  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().int().default(8),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message; do not leak values.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const webhookIpAllowlist = env.WEBHOOK_IP_ALLOWLIST.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
