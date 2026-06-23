import { RuijieCloudClient } from './cloud';
import type { RuijieClient, RuijieConfig } from './types';

/**
 * Build a Ruijie client. Mirrors createMikrotikClient(): the concrete driver
 * slots in behind the RuijieClient interface. `cloud` (Ruijie Cloud OpenAPI) is
 * implemented and validated live; `local` (eWeb over LAN) is a future fallback.
 */
export function createRuijieClient(cfg: RuijieConfig): RuijieClient {
  switch (cfg.driver) {
    case 'cloud':
      return new RuijieCloudClient(cfg);
    case 'local':
      throw new Error(
        'Ruijie local (eWeb) driver not implemented — cloud is the validated path for RG-EW1300G.',
      );
    default:
      throw new Error(`Unknown Ruijie driver: ${String((cfg as RuijieConfig).driver)}`);
  }
}

export * from './types';
export * from './account';
export { RuijieCloudClient, RuijieApiError } from './cloud';
