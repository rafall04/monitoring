import type {
  AddressListEntry,
  BlockIntent,
  DhcpLeaseDTO,
  FirewallBlockRule,
  HotspotActive,
  HotspotProfile,
  HotspotUser,
  RouterOsVersion,
  RouterResource,
  SimpleQueueDTO,
} from '@noc/shared';

export interface AddAddressListInput {
  list: string;
  address: string;
  comment?: string;
}

export interface AddSimpleQueueInput {
  name: string;
  target: string;
  maxLimit: string; // "up/down"
}

export interface MikrotikConfig {
  host: string;
  port: number;
  useTls: boolean;
  username: string;
  password: string;
  version: RouterOsVersion;
  timeoutMs?: number;
}

export interface NetwatchEntry {
  id?: string;
  host: string;
  status: 'up' | 'down' | 'unknown';
  since?: string;
  comment?: string;
  name?: string;
}

export interface AddNetwatchInput {
  host: string;
  interval?: string; // e.g. "00:00:10"
  timeout?: string;  // e.g. "1000ms"  (MikroTik ICMP timeout)
  upScript: string;
  downScript: string;
  comment?: string;
}

export interface AddHotspotUserInput {
  name: string;
  password?: string;
  profile?: string;
  server?: string;
  limitUptime?: string;
  limitBytesTotal?: string;
  comment?: string;
}

export interface UpsertHotspotProfileInput {
  name: string;
  rateLimit?: string;
  sharedUsers?: string;
  sessionTimeout?: string;
}

/**
 * Unified MikroTik client. v6 (binary API) is implemented; a v7 REST adapter can
 * be added later behind this same interface without touching call sites.
 */
export interface MikrotikClient {
  getIdentity(): Promise<string>;
  getResource(): Promise<RouterResource>;

  listNetwatch(): Promise<NetwatchEntry[]>;
  addNetwatch(input: AddNetwatchInput): Promise<void>;
  removeNetwatchByHost(host: string): Promise<void>;

  listHotspotServers(): Promise<string[]>;
  listHotspotProfiles(): Promise<HotspotProfile[]>;
  listHotspotUsers(): Promise<HotspotUser[]>;
  addHotspotUser(input: AddHotspotUserInput): Promise<void>;
  updateHotspotUser(id: string, patch: Partial<AddHotspotUserInput>): Promise<void>;
  removeHotspotUser(id: string): Promise<void>;
  addHotspotProfile(input: UpsertHotspotProfileInput): Promise<void>;
  updateHotspotProfile(id: string, patch: Partial<UpsertHotspotProfileInput>): Promise<void>;

  listHotspotActive(): Promise<HotspotActive[]>;
  disconnectHotspotActive(id: string): Promise<void>;

  // Access control (firewall): forward drop/reject rules as on/off blocks, plus
  // block address-lists (add/remove a device or subnet). Writes need a router
  // user with the `write` policy.
  listFirewallBlocks(): Promise<FirewallBlockRule[]>;
  setBlockActive(id: string, active: boolean): Promise<void>;
  listAddressListEntries(list?: string): Promise<AddressListEntry[]>;
  addAddressListEntry(input: AddAddressListInput): Promise<void>;
  removeAddressListEntry(id: string): Promise<void>;

  // Managed block system (clean noc-block chain + noc-svc/noc-grp lists)
  ensureBlockChain(): Promise<void>;
  listBlockIntents(): Promise<BlockIntent[]>;
  ensureServiceDomains(service: string, domains: string[]): Promise<void>;
  createIntent(input: { group: string; service: string }): Promise<void>;
  setIntentActive(id: string, active: boolean): Promise<void>;
  removeIntent(id: string): Promise<void>;

  // Bandwidth / QoS
  listSimpleQueues(): Promise<SimpleQueueDTO[]>;
  addSimpleQueue(input: AddSimpleQueueInput): Promise<void>;
  setSimpleQueueMax(id: string, maxLimit: string): Promise<void>;
  removeSimpleQueue(id: string): Promise<void>;
  listDhcpLeases(): Promise<DhcpLeaseDTO[]>;
  /** Set a lease's rate-limit ('' clears it). Dynamic leases are made static first. */
  setLeaseRateLimit(id: string, rateLimit: string): Promise<void>;

  /** Save a router-side config backup (restore point) before a change. */
  saveBackup(name: string): Promise<void>;

  close(): Promise<void>;
}
