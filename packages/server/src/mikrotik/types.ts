import type {
  AccessMember,
  AccessProfile,
  AddressListEntry,
  BlockIntent,
  DeviceNetInfo,
  DhcpLeaseDTO,
  FirewallBlockRule,
  HotspotActive,
  HotspotProfile,
  HotspotUser,
  PingResult,
  RouterLogEntry,
  RouterOsVersion,
  RouterResource,
  SimpleQueueDTO,
  TraceHop,
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
  /** Ping interval as RouterOS reports it, e.g. "30s" / "00:00:10". */
  interval?: string;
  /**
   * Whether the entry actually carries our webhook scripts. An entry without
   * them still shows a status on the router, but never pushes a change to the
   * NOC — detection then falls back to the 20s poller. Needed to tell a
   * properly wired entry from a hand-made one.
   */
  hasUpScript?: boolean;
  hasDownScript?: boolean;
  disabled?: boolean;
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
  addressList?: string; // '' clears the binding; set to noc-grp-<name> for an Access Profile
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
  /**
   * Remove by RouterOS id. Saves the lookup round-trip when the caller already
   * listed the table — which matters in bulk loops, where removeNetwatchByHost
   * would otherwise issue a filtered print per device.
   */
  removeNetwatchById(id: string): Promise<void>;

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

  // Managed block system (clean noc-block chain + noc-svc/noc-grp lists).
  // An "intent" is the SET of rules for one group×service (domain/IP drop +
  // tls-host SNI drops), all sharing comment `NOC:<group>|<service>`. ensureBlockChain
  // also seeds the noc-rfc1918 list + the one global QUIC (udp/443) drop. The `id`
  // passed to setIntentActive/removeIntent is the synthetic key '<group>|<service>'
  // (from listBlockIntents), and toggles/removes every rule in that set.
  ensureBlockChain(): Promise<void>;
  listBlockIntents(): Promise<BlockIntent[]>;
  ensureServiceDomains(service: string, addresses: string[]): Promise<void>;
  createIntent(input: { group: string; service: string; tlsHosts?: string[] }): Promise<void>;
  setIntentActive(id: string, active: boolean): Promise<void>;
  removeIntent(id: string): Promise<void>;
  /** Remove a single filter rule by raw RouterOS .id (legacy /blocks cleanup). */
  removeFilterRule(id: string): Promise<void>;

  // Access profiles: a hotspot user-profile bound to address-list noc-grp-<name>,
  // whose blocklist policy is enforced by the per-group block engine above. Members
  // join the group via the profile (hotspot login), a static subnet/IP entry, or a
  // per-MAC mangle tag (which follows the device across VLANs).
  listAccessProfiles(): Promise<AccessProfile[]>;
  createAccessProfile(name: string): Promise<void>;
  /** Tear down a profile's policy/members and unbind it (keeps the hotspot profile). */
  deleteAccessProfile(name: string): Promise<void>;
  listGroupMembers(name: string): Promise<AccessMember[]>;
  addGroupMac(name: string, mac: string): Promise<void>;
  removeGroupMac(name: string, mac: string): Promise<void>;
  /** Allowlist mode: seed local+DNS into noc-allow-<name>, reconcile the allowed
   *  destinations, and ensure the deny-all drop (created DISABLED unless enforce=true). */
  setAllowlist(name: string, allow: string[], enforce: boolean): Promise<void>;
  /** Remove the allowlist deny-all rule + noc-allow-<name> (switch back to blocklist). */
  removeAllowlist(name: string): Promise<void>;

  // Bandwidth / QoS
  listSimpleQueues(): Promise<SimpleQueueDTO[]>;
  addSimpleQueue(input: AddSimpleQueueInput): Promise<void>;
  setSimpleQueueMax(id: string, maxLimit: string): Promise<void>;
  removeSimpleQueue(id: string): Promise<void>;
  listDhcpLeases(): Promise<DhcpLeaseDTO[]>;
  /** Set a lease's rate-limit ('' clears it). Dynamic leases are made static first. */
  setLeaseRateLimit(id: string, rateLimit: string): Promise<void>;

  // Diagnostics (read-only) + remediation. Ping/traceroute/log run a router
  // command; net-info reads ARP + DHCP + the PoE port; power-cycle is a write.
  pingHost(ip: string, count?: number): Promise<PingResult>;
  tracePath(ip: string): Promise<TraceHop[]>;
  deviceNetInfo(ip: string): Promise<DeviceNetInfo>;
  recentLog(limit?: number): Promise<RouterLogEntry[]>;
  poePowerCycle(port: string): Promise<void>;

  /** Save a router-side config backup (restore point) before a change. */
  saveBackup(name: string): Promise<void>;

  close(): Promise<void>;
}
