import type { RuijieClient, RuijieConfig } from './types';

/**
 * Build a Ruijie client for a router. Mirrors createMikrotikClient(): the concrete
 * driver slots in here behind the RuijieClient interface with zero call-site
 * changes. Both drivers are stubs pending the integration research — which path is
 * viable for RG-EW1300G (SNMP vs Cloud OpenAPI) is still being verified.
 */
export function createRuijieClient(cfg: RuijieConfig): RuijieClient {
  switch (cfg.driver) {
    case 'snmp':
      // Pending research: confirm RG-EW1300G (Reyee EW home line) actually
      // exposes an associated-clients OID over SNMP, then implement here.
      throw new Error('Ruijie SNMP driver not implemented yet (pending research).');
    case 'cloud':
      // Pending research: confirm Ruijie Cloud OpenAPI access + the per-device
      // online-client endpoint, then implement here.
      throw new Error('Ruijie Cloud OpenAPI driver not implemented yet (pending research).');
    default:
      throw new Error(`Unknown Ruijie driver: ${String((cfg as RuijieConfig).driver)}`);
  }
}

export * from './types';
