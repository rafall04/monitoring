// Ruijie (Reyee) integration — a SEPARATE, capability-scoped client, deliberately
// NOT the MikrotikClient interface. Reyee devices have no Netwatch/hotspot
// equivalent, so the only capability the NOC needs today is "how many clients are
// connected to this router". Two drivers are planned behind this interface
// (SNMP over LAN, or Ruijie Cloud OpenAPI); the viable one for RG-EW1300G is being
// confirmed by research. See createRuijieClient() in ./index.ts.

/** A client currently associated to a Ruijie router. Minimal — extend later. */
export interface RuijieClientInfo {
  mac?: string;
  ip?: string;
  hostname?: string;
  /** dBm, when the source exposes it (SNMP/cloud often won't). */
  rssi?: number;
  ssid?: string;
}

/** Snapshot of who is connected to one Ruijie router right now. */
export interface RuijieConnectedClients {
  /** The contract. Per-client `clients` is best-effort (driver-dependent). */
  count: number;
  clients?: RuijieClientInfo[];
  /** When the source produced this (cloud data can lag; SNMP is near-live). */
  sampledAt: string;
}

/**
 * Capability-scoped Ruijie client. The whole contract is "count the connected
 * clients" — intentionally tiny so a Reyee device never has to fake MikroTik
 * concepts. Wired per router by RuijieConfig.driver.
 */
export interface RuijieClient {
  getConnectedClients(): Promise<RuijieConnectedClients>;
  close(): Promise<void>;
}

export type RuijieDriver = 'snmp' | 'cloud';

export interface RuijieConfig {
  driver: RuijieDriver;
  timeoutMs?: number;

  // --- SNMP driver (LAN access) ---
  host?: string;
  snmpPort?: number;
  snmpCommunity?: string;

  // --- Cloud OpenAPI driver (internet) ---
  cloudBaseUrl?: string;
  cloudAppKey?: string;
  cloudAppSecret?: string;
  /** Ruijie Cloud serial number used to address this router in the API. */
  cloudDeviceSn?: string;
}
