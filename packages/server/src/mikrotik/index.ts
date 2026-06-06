import type { RouterOsVersion } from '@noc/shared';
import { decryptSecret } from '../crypto';
import type { MikrotikClient, MikrotikConfig } from './types';
import { RouterOsV6Client } from './v6';

export function createMikrotikClient(cfg: MikrotikConfig): MikrotikClient {
  if (cfg.version === 'v6') return new RouterOsV6Client(cfg);
  // v7 REST adapter is intentionally not implemented yet. It plugs in here behind
  // the same MikrotikClient interface with zero changes to call sites.
  throw new Error(
    'RouterOS v7 REST adapter not implemented yet. Configure the router as v6 (binary API) for now.',
  );
}

/** Build a client from a router row, decrypting its stored password. */
export function clientForRouter(router: {
  host: string;
  apiPort: number;
  useTls: boolean;
  username: string;
  passwordEncrypted: string;
  routerosVersion: string;
}): MikrotikClient {
  return createMikrotikClient({
    host: router.host,
    port: router.apiPort,
    useTls: router.useTls,
    username: router.username,
    password: decryptSecret(router.passwordEncrypted),
    version: router.routerosVersion as RouterOsVersion,
  });
}

export * from './types';
export * from './netwatch';
