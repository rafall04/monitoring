// =============================================================================
// RouterOS v6 adapter using the binary API (node-routeros, ports 8728/8729).
// Lazily connects on first use and reuses the connection until close().
// Results from the binary API are untyped rows; we map them to our DTOs.
// =============================================================================

import { RouterOSAPI } from 'node-routeros';
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
  RouterInterface,
  RouterLogEntry,
  RouterResource,
  SimpleQueueDTO,
  TraceHop,
} from '@noc/shared';
import type {
  AddAddressListInput,
  AddHotspotUserInput,
  AddNetwatchInput,
  AddSimpleQueueInput,
  MikrotikClient,
  MikrotikConfig,
  NetwatchEntry,
  UpsertHotspotProfileInput,
} from './types';

/** Human-readable description of how a forward drop/reject rule blocks. */
function describeBlock(r: Row): string {
  const l7 = r['layer7-protocol'];
  const dal = r['dst-address-list'];
  const sal = r['src-address-list'];
  const port = r['dst-port'];
  const parts: string[] = [];
  if (l7) parts.push(`Layer7: ${l7}`);
  if (sal) parts.push(`dari list ${sal}`);
  if (dal) parts.push(`ke ${dal}`);
  if (port) parts.push(`port ${port}`);
  return parts.join(' · ') || 'forward drop';
}

type Row = Record<string, string>;

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a RouterOS latency token ("1ms", "512us", "1s300ms") into milliseconds. */
function parseMs(t: string | undefined): number | null {
  if (!t) return null;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|us|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    matched = true;
    const v = Number(m[1]);
    total += m[2] === 's' ? v * 1000 : m[2] === 'us' ? v / 1000 : v;
  }
  return matched ? Math.round(total * 100) / 100 : null;
}

/** Parse a RouterOS percentage token ("0%", "100%") into a number. */
function parsePct(t: string | undefined): number | null {
  if (t == null) return null;
  const n = Number(t.replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

// Writable user-profile props copied when cloning a base profile into a
// device-tier variant (<base>-<n>D). name/shared-users are set explicitly.
const PROFILE_CLONE_PROPS = [
  'idle-timeout',
  'keepalive-timeout',
  'status-autorefresh',
  'rate-limit',
  'session-timeout',
  'add-mac-cookie',
  'mac-cookie-timeout',
  'http-cookie-lifetime',
  'address-pool',
  'address-list',
  'transparent-proxy',
  'open-status-page',
  'advertise',
  'advertise-url',
  'advertise-interval',
  'incoming-filter',
  'outgoing-filter',
  'incoming-packet-mark',
  'outgoing-packet-mark',
];

export class RouterOsV6Client implements MikrotikClient {
  private conn: RouterOSAPI | null = null;
  private connected = false;
  /** In-flight connect, so concurrent callers share one socket. */
  private connecting: Promise<RouterOSAPI> | null = null;
  private readonly cfg: MikrotikConfig;

  constructor(cfg: MikrotikConfig) {
    this.cfg = cfg;
  }

  private async api(): Promise<RouterOSAPI> {
    if (this.conn && this.connected) return this.conn;
    // Collapse concurrent first-use into ONE connect. Without this, two calls
    // issued in the same tick both see a null conn and each open their own
    // socket + login; the later assignment wins and the earlier socket is
    // orphaned, never closed. getResource() does exactly that (it Promise.all's
    // getIdentity with a resource print), so every poll of every router was
    // opening two connections and leaking one — measured on production.
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async openConnection(): Promise<RouterOSAPI> {
    const timeoutSec = Math.max(2, Math.ceil((this.cfg.timeoutMs ?? 8000) / 1000));
    const conn = new RouterOSAPI({
      host: this.cfg.host,
      user: this.cfg.username,
      password: this.cfg.password,
      port: this.cfg.port,
      timeout: timeoutSec,
      // Self-signed certs are the norm on MikroTik; we still get encryption in
      // transit. Pin a CA here if your routers use one.
      ...(this.cfg.useTls ? { tls: { rejectUnauthorized: false } } : {}),
    });
    // node-routeros can emit an async 'error' (e.g. SOCKTMOUT) from a socket
    // timeout timer, outside the connect()/write() promise chain. Without a
    // listener Node treats it as fatal. Absorb it here — the awaited call still
    // rejects and the caller handles the real failure.
    (conn as unknown as { on?: (ev: string, cb: (e: unknown) => void) => void }).on?.(
      'error',
      () => {
        this.connected = false;
      },
    );
    await conn.connect();
    this.conn = conn;
    this.connected = true;
    return conn;
  }

  private async write(menu: string, params: string[] = []): Promise<Row[]> {
    const api = await this.api();
    try {
      const res = (await api.write(menu, params)) as unknown as Row[];
      return res ?? [];
    } catch (err) {
      // Drop the connection so the next call reconnects cleanly.
      this.connected = false;
      throw err;
    }
  }

  async getIdentity(): Promise<string> {
    const res = await this.write('/system/identity/print');
    return res[0]?.name ?? '';
  }

  async getResource(): Promise<RouterResource> {
    const [id, res] = await Promise.all([
      this.getIdentity().catch(() => ''),
      this.write('/system/resource/print'),
    ]);
    const r = res[0] ?? {};
    return {
      identity: id || undefined,
      uptime: r['uptime'],
      cpuLoad: num(r['cpu-load']),
      freeMemory: num(r['free-memory']),
      totalMemory: num(r['total-memory']),
      version: r['version'],
      boardName: r['board-name'],
    };
  }

  /** `/interface/print` — every interface; `running` drives uplink status. */
  async listInterfaces(): Promise<RouterInterface[]> {
    const res = await this.write('/interface/print');
    return res.map((r) => ({
      name: r['name'] ?? '',
      type: r['type'] ?? '',
      running: r['running'] === 'true',
      disabled: r['disabled'] === 'true',
    }));
  }

  async listNetwatch(): Promise<NetwatchEntry[]> {
    const res = await this.write('/tool/netwatch/print');
    return res.map((r) => ({
      id: r['.id'],
      host: r['host'] ?? '',
      status: (r['status'] as NetwatchEntry['status']) ?? 'unknown',
      since: r['since'],
      comment: r['comment'],
      name: r['name'],
      interval: r['interval'],
      hasUpScript: (r['up-script'] ?? '').length > 0,
      hasDownScript: (r['down-script'] ?? '').length > 0,
      disabled: r['disabled'] === 'true',
    }));
  }

  async addNetwatch(input: AddNetwatchInput): Promise<void> {
    const params = [
      `=host=${input.host}`,
      `=interval=${input.interval ?? '00:00:10'}`,
      `=up-script=${input.upScript}`,
      `=down-script=${input.downScript}`,
    ];
    if (input.timeout) params.push(`=timeout=${input.timeout}`);
    if (input.comment) params.push(`=comment=${input.comment}`);
    await this.write('/tool/netwatch/add', params);
  }

  async removeNetwatchByHost(host: string): Promise<void> {
    const rows = await this.write('/tool/netwatch/print', [`?host=${host}`]);
    for (const r of rows) {
      if (r['.id']) await this.write('/tool/netwatch/remove', [`=.id=${r['.id']}`]);
    }
  }

  async removeNetwatchById(id: string): Promise<void> {
    await this.write('/tool/netwatch/remove', [`=.id=${id}`]);
  }

  async listHotspotServers(): Promise<string[]> {
    const res = await this.write('/ip/hotspot/print');
    return res.map((r) => r['name']).filter((n): n is string => Boolean(n));
  }

  async listHotspotProfiles(): Promise<HotspotProfile[]> {
    const res = await this.write('/ip/hotspot/user/profile/print');
    return res.map((r) => ({
      '.id': r['.id'],
      name: r['name'] ?? '',
      'rate-limit': r['rate-limit'],
      'shared-users': r['shared-users'],
      'session-timeout': r['session-timeout'],
      'address-list': r['address-list'],
    }));
  }

  async listHotspotUsers(withSecrets = false): Promise<HotspotUser[]> {
    const res = await this.write('/ip/hotspot/user/print');
    return res.map((r) => this.mapHotspotUser(r, withSecrets));
  }

  async getHotspotUserByName(name: string): Promise<HotspotUser | null> {
    const res = await this.write('/ip/hotspot/user/print', [`?name=${name}`]);
    const r = res[0];
    return r ? this.mapHotspotUser(r, true) : null;
  }

  private mapHotspotUser(
    r: Record<string, string>,
    withSecrets: boolean,
  ): HotspotUser {
    return {
      '.id': r['.id'],
      name: r['name'] ?? '',
      profile: r['profile'],
      server: r['server'],
      'limit-uptime': r['limit-uptime'],
      'limit-bytes-total': r['limit-bytes-total'],
      'mac-address': r['mac-address'],
      uptime: r['uptime'],
      'bytes-in': r['bytes-in'],
      'bytes-out': r['bytes-out'],
      comment: r['comment'],
      disabled: r['disabled'],
      ...(withSecrets ? { password: r['password'] } : {}),
    };
  }

  async addHotspotUser(input: AddHotspotUserInput): Promise<void> {
    await this.write('/ip/hotspot/user/add', this.hotspotParams(input));
  }

  async updateHotspotUser(id: string, patch: Partial<AddHotspotUserInput>): Promise<void> {
    await this.write('/ip/hotspot/user/set', [
      `=.id=${id}`,
      ...this.hotspotParams(patch),
    ]);
  }

  async removeHotspotUser(id: string): Promise<void> {
    await this.write('/ip/hotspot/user/remove', [`=.id=${id}`]);
  }

  async resetHotspotUserCounters(id: string): Promise<void> {
    await this.write('/ip/hotspot/user/reset-counters', [`=numbers=${id}`]);
  }

  async addHotspotProfile(input: UpsertHotspotProfileInput): Promise<void> {
    await this.write('/ip/hotspot/user/profile/add', this.profileParams(input));
  }

  async updateHotspotProfile(
    id: string,
    patch: Partial<UpsertHotspotProfileInput>,
  ): Promise<void> {
    await this.write('/ip/hotspot/user/profile/set', [
      `=.id=${id}`,
      ...this.profileParams(patch),
    ]);
  }

  // RouterOS has no per-user shared-users — only user-profiles carry it. A
  // per-user "devices" value is therefore realised by a device-tier variant
  // profile (`<base>-<n>D`): a clone of the base profile with shared-users=n.
  // The clone keeps the base's address-list, so the variant's members land in
  // the same noc-grp-* group and keep the identical app-blocking policy.
  async ensureUserProfileVariant(
    from: string,
    to: string,
    sharedUsers: string,
  ): Promise<void> {
    const existing = await this.write('/ip/hotspot/user/profile/print', [`?name=${to}`]);
    const cur = existing[0];
    if (cur) {
      if (cur['shared-users'] !== sharedUsers) {
        await this.write('/ip/hotspot/user/profile/set', [
          `=.id=${cur['.id']}`,
          `=shared-users=${sharedUsers}`,
        ]);
      }
      return;
    }
    const base = await this.write('/ip/hotspot/user/profile/print', [`?name=${from}`]);
    const src = base[0];
    if (!src) throw new Error(`Profile "${from}" tidak ditemukan di router`);
    const p = [`=name=${to}`, `=shared-users=${sharedUsers}`];
    for (const k of PROFILE_CLONE_PROPS) {
      const v = src[k];
      if (v != null && v !== '') p.push(`=${k}=${v}`);
    }
    await this.write('/ip/hotspot/user/profile/add', p);
  }

  async listHotspotActive(): Promise<HotspotActive[]> {
    const res = await this.write('/ip/hotspot/active/print');
    return res.map((r) => ({
      '.id': r['.id'],
      user: r['user'],
      address: r['address'],
      'mac-address': r['mac-address'],
      uptime: r['uptime'],
      'bytes-in': r['bytes-in'],
      'bytes-out': r['bytes-out'],
      'packets-in': r['packets-in'],
      'packets-out': r['packets-out'],
      'idle-time': r['idle-time'],
      'session-time-left': r['session-time-left'],
      'login-by': r['login-by'],
      server: r['server'],
    }));
  }

  async disconnectHotspotActive(id: string): Promise<void> {
    await this.write('/ip/hotspot/active/remove', [`=.id=${id}`]);
  }

  async listFirewallBlocks(): Promise<FirewallBlockRule[]> {
    const res = await this.write('/ip/firewall/filter/print');
    return res
      .filter((r) => r['chain'] === 'forward' && (r['action'] === 'drop' || r['action'] === 'reject'))
      .map((r) => ({
        id: r['.id'] ?? '',
        comment: (r['comment'] ?? '').trim(),
        action: r['action'] ?? 'drop',
        active: r['disabled'] !== 'true',
        method: describeBlock(r),
      }));
  }

  async setBlockActive(id: string, active: boolean): Promise<void> {
    await this.write('/ip/firewall/filter/set', [`=.id=${id}`, `=disabled=${active ? 'no' : 'yes'}`]);
  }

  async listAddressListEntries(list?: string): Promise<AddressListEntry[]> {
    const params = list ? [`?list=${list}`] : [];
    const res = await this.write('/ip/firewall/address-list/print', params);
    return res.map((r) => ({
      id: r['.id'] ?? '',
      list: r['list'] ?? '',
      address: r['address'] ?? '',
      comment: r['comment'] ?? null,
      dynamic: r['dynamic'] === 'true',
    }));
  }

  async addAddressListEntry(input: AddAddressListInput): Promise<void> {
    const params = [`=list=${input.list}`, `=address=${input.address}`];
    if (input.comment) params.push(`=comment=${input.comment}`);
    await this.write('/ip/firewall/address-list/add', params);
  }

  async removeAddressListEntry(id: string): Promise<void> {
    await this.write('/ip/firewall/address-list/remove', [`=.id=${id}`]);
  }

  private readonly BLOCK_CHAIN = 'noc-block';
  private readonly RFC1918_LIST = 'noc-rfc1918';
  // A group's QUIC (udp/443) drop is infra shared by all that group's service
  // intents. Its comment deliberately lacks the 'NOC:<group>|<service>' shape so
  // listBlockIntents never lists it as a toggleable service.
  private quicComment(group: string): string {
    return `NOC-QUIC:${group}`;
  }

  private groupOf(id: string): string {
    const bar = id.indexOf('|');
    return bar >= 0 ? id.slice(0, bar) : 'semua';
  }

  async ensureBlockChain(): Promise<void> {
    const fwd = await this.write('/ip/firewall/filter/print', ['?chain=forward']);
    if (!fwd.some((r) => r['action'] === 'jump' && r['jump-target'] === this.BLOCK_CHAIN)) {
      const params = [
        '=chain=forward',
        '=action=jump',
        `=jump-target=${this.BLOCK_CHAIN}`,
        '=comment=NOC: managed block chain',
      ];
      // Put it at the very top of forward so blocks win before fasttrack/accept.
      const firstId = fwd[0]?.['.id'];
      if (firstId) params.push(`=place-before=${firstId}`);
      await this.write('/ip/firewall/filter/add', params);
    }
    // The RFC1918 exclusion list the per-group QUIC drops reference (created lazily
    // in createIntent). Seeded here so it always exists first. Idempotent.
    await this.ensureRfc1918();
  }

  /** Seed the local-ranges list the QUIC drop excludes, so only internet-bound
   *  udp/443 is killed (never intra-LAN). Idempotent. */
  private async ensureRfc1918(): Promise<void> {
    const cidrs = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];
    const rows = await this.write('/ip/firewall/address-list/print', [`?list=${this.RFC1918_LIST}`]);
    const have = new Set(rows.map((r) => r['address']));
    for (const c of cidrs) {
      if (!have.has(c)) {
        await this.write('/ip/firewall/address-list/add', [
          `=list=${this.RFC1918_LIST}`,
          `=address=${c}`,
          '=comment=NOC rfc1918',
        ]);
      }
    }
  }

  /** Ensure ONE QUIC (udp/443 → internet) drop for a group. tls-host can't parse
   *  QUIC, so this forces HTTP/3 clients back to TCP where the SNI drops bite. Scoped
   *  to the group (router-wide only for 'semua'); created enabled. Idempotent. */
  private async ensureQuicDrop(group: string): Promise<void> {
    const comment = this.quicComment(group);
    const rows = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    if (rows.some((r) => (r['comment'] ?? '').trim() === comment)) return;
    const params = [
      `=chain=${this.BLOCK_CHAIN}`,
      '=action=drop',
      '=protocol=udp',
      '=dst-port=443',
      `=dst-address-list=!${this.RFC1918_LIST}`,
      `=comment=${comment}`,
    ];
    if (group !== 'semua') params.push(`=src-address-list=noc-grp-${group}`);
    await this.write('/ip/firewall/filter/add', params);
  }

  /** Keep a group's QUIC drop in lockstep with its services: enabled iff at least one
   *  service intent in the group is enabled. No-op if the QUIC rule is absent. */
  private async syncGroupQuic(group: string): Promise<void> {
    const rows = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    const quic = rows.find((r) => (r['comment'] ?? '').trim() === this.quicComment(group));
    const rid = quic?.['.id'];
    if (!rid) return;
    const prefix = `NOC:${group}|`;
    const anyEnabled = rows.some(
      (r) => (r['comment'] ?? '').trim().startsWith(prefix) && r['disabled'] !== 'true',
    );
    await this.write('/ip/firewall/filter/set', [`=.id=${rid}`, `=disabled=${anyEnabled ? 'no' : 'yes'}`]);
  }

  async listBlockIntents(): Promise<BlockIntent[]> {
    const rows = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    // One intent = several rules sharing comment `NOC:<group>|<service>`. Collapse
    // them into a single BlockIntent (id = the '<group>|<service>' key); active only
    // when EVERY member rule is enabled. Rows without that exact comment (the per-group
    // QUIC drop 'NOC-QUIC:*', or manual/legacy rules) are not intents — skip them.
    const byKey = new Map<string, BlockIntent>();
    for (const r of rows) {
      const m = /^NOC:([^|]+)\|(.+)$/.exec((r['comment'] ?? '').trim());
      if (!m) continue;
      const group = m[1];
      const service = m[2];
      if (group === undefined || service === undefined) continue;
      const key = `${group}|${service}`;
      const enabled = r['disabled'] !== 'true';
      const prev = byKey.get(key);
      if (prev) prev.active = prev.active && enabled;
      else byKey.set(key, { id: key, group, service, active: enabled });
    }
    return [...byKey.values()];
  }

  /** Fill noc-svc-<service> with the service addresses (auto-resolving domains AND
   *  static CIDRs both live here). Idempotent. */
  async ensureServiceDomains(service: string, addresses: string[]): Promise<void> {
    const list = `noc-svc-${service}`;
    const rows = await this.write('/ip/firewall/address-list/print', [`?list=${list}`]);
    const have = new Set(rows.map((r) => r['address']));
    for (const a of addresses) {
      if (!have.has(a)) {
        await this.write('/ip/firewall/address-list/add', [
          `=list=${list}`,
          `=address=${a}`,
          '=comment=NOC svc',
        ]);
      }
    }
  }

  async createIntent(input: { group: string; service: string; tlsHosts?: string[] }): Promise<void> {
    const comment = `NOC:${input.group}|${input.service}`;
    const src = input.group !== 'semua' ? [`=src-address-list=noc-grp-${input.group}`] : [];
    // The group's QUIC drop is shared infra for all its services — ensure it exists
    // (tied to this group's lifecycle via setIntentActive/removeIntent).
    await this.ensureQuicDrop(input.group);
    // Snapshot the chain so re-running (e.g. from a toggle-on) converges — adds only
    // the rules that are missing — instead of stacking duplicates.
    const existing = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    const sameComment = existing.filter((r) => (r['comment'] ?? '').trim() === comment);

    // (1) address-list drop — covers resolved domains AND the static ipRanges that
    //     the route folded into noc-svc-<service> (the no-SNI media/call traffic).
    const dstList = `noc-svc-${input.service}`;
    if (!sameComment.some((r) => r['dst-address-list'] === dstList && !r['tls-host'])) {
      await this.write('/ip/firewall/filter/add', [
        `=chain=${this.BLOCK_CHAIN}`,
        '=action=drop',
        `=dst-address-list=${dstList}`,
        ...src,
        `=comment=${comment}`,
      ]);
    }
    // (2) one tls-host (SNI) drop per glob — MUST carry protocol=tcp (RouterOS 6.49
    //     rejects tls-host without it: "tls host matcher valid only for tcp").
    for (const host of input.tlsHosts ?? []) {
      if (sameComment.some((r) => r['tls-host'] === host)) continue;
      await this.write('/ip/firewall/filter/add', [
        `=chain=${this.BLOCK_CHAIN}`,
        '=action=drop',
        '=protocol=tcp',
        `=tls-host=${host}`,
        ...src,
        `=comment=${comment}`,
      ]);
    }
  }

  /** Toggle every rule of the intent set keyed by '<group>|<service>', then re-sync
   *  the group's QUIC drop so it is enabled iff the group still has an active service. */
  async setIntentActive(id: string, active: boolean): Promise<void> {
    const comment = `NOC:${id}`;
    const rows = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    for (const r of rows) {
      if ((r['comment'] ?? '').trim() !== comment) continue;
      const rid = r['.id'];
      if (rid) {
        await this.write('/ip/firewall/filter/set', [`=.id=${rid}`, `=disabled=${active ? 'no' : 'yes'}`]);
      }
    }
    await this.syncGroupQuic(this.groupOf(id));
  }

  /** Remove every rule of the intent set keyed by '<group>|<service>'. When the group
   *  has no service intents left, tear down its QUIC drop too (no orphaned global
   *  udp/443 blackhole); otherwise re-sync it. */
  async removeIntent(id: string): Promise<void> {
    const comment = `NOC:${id}`;
    const group = this.groupOf(id);
    const rows = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    for (const r of rows) {
      if ((r['comment'] ?? '').trim() !== comment) continue;
      const rid = r['.id'];
      if (rid) await this.write('/ip/firewall/filter/remove', [`=.id=${rid}`]);
    }
    const after = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    const prefix = `NOC:${group}|`;
    if (!after.some((r) => (r['comment'] ?? '').trim().startsWith(prefix))) {
      const quicComment = this.quicComment(group);
      for (const r of after) {
        if ((r['comment'] ?? '').trim() !== quicComment) continue;
        const rid = r['.id'];
        if (rid) await this.write('/ip/firewall/filter/remove', [`=.id=${rid}`]);
      }
    } else {
      await this.syncGroupQuic(group);
    }
  }

  /** Remove a single filter rule by raw RouterOS .id (legacy /blocks cleanup). */
  async removeFilterRule(id: string): Promise<void> {
    await this.write('/ip/firewall/filter/remove', [`=.id=${id}`]);
  }

  // ---- Access profiles ------------------------------------------------------
  // A profile is a hotspot user-profile whose address-list = noc-grp-<name>; its
  // blocklist policy is the per-group intents above. Group membership is fed by the
  // profile (hotspot login), static subnet/IP entries, and per-MAC mangle tags.

  private readonly MANGLE_TAG = '/ip/firewall/mangle';

  // Names we must never turn into an Access Profile: 'default' is RouterOS's built-in
  // hotspot user-profile, 'semua' is the block engine's reserved router-wide group.
  private readonly RESERVED_ACCESS_NAMES = ['default', 'semua'];

  async createAccessProfile(name: string): Promise<void> {
    if (this.RESERVED_ACCESS_NAMES.includes(name.toLowerCase())) {
      throw new Error(`Nama profil "${name}" dilindungi dan tidak boleh dipakai.`);
    }
    await this.ensureBlockChain();
    const list = `noc-grp-${name}`;
    const profs = await this.write('/ip/hotspot/user/profile/print', [`?name=${name}`]);
    const existing = profs.find((r) => r['name'] === name);
    if (existing && existing['.id']) {
      // Never hijack a hotspot profile that already carries a different address-list
      // (that binding belongs to something else — overwriting it is destructive).
      const current = existing['address-list'] ?? '';
      if (current && current !== list) {
        throw new Error(
          `Hotspot profile "${name}" sudah punya address-list "${current}". Pakai nama lain atau lepaskan binding-nya dulu.`,
        );
      }
      await this.write('/ip/hotspot/user/profile/set', [`=.id=${existing['.id']}`, `=address-list=${list}`]);
    } else {
      await this.write('/ip/hotspot/user/profile/add', [`=name=${name}`, `=address-list=${list}`]);
    }
  }

  async listAccessProfiles(): Promise<AccessProfile[]> {
    const profs = await this.write('/ip/hotspot/user/profile/print');
    // Skip device-tier variants (<name>-<n>D): they share the base's noc-grp
    // binding, so listing them would double-count the same policy as separate
    // "access profiles" with an empty service set.
    const access = profs.filter(
      (r) =>
        (r['address-list'] ?? '').startsWith('noc-grp-') &&
        !/-\d+D$/.test(r['name'] ?? ''),
    );
    if (access.length === 0) return [];
    const intents = await this.listBlockIntents();
    const chain = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    const out: AccessProfile[] = [];
    for (const p of access) {
      const name = p['name'];
      if (!name) continue;
      const allowRule = chain.find((r) => (r['comment'] ?? '').trim() === `NOC-ALLOW:${name}`);
      const svc = intents.filter((i) => i.group === name);
      const members = await this.listGroupMembers(name);
      let allow: string[] = [];
      if (allowRule) {
        const al = await this.write('/ip/firewall/address-list/print', [`?list=noc-allow-${name}`]);
        allow = al
          .filter((e) => (e['comment'] ?? '').trim() === 'NOC-ALLOW-DEST')
          .map((e) => e['address'] ?? '')
          .filter(Boolean);
      }
      out.push({
        name,
        group: p['address-list'] ?? `noc-grp-${name}`,
        mode: allowRule ? 'allowlist' : 'blocklist',
        services: svc.map((i) => i.service),
        allow,
        active: allowRule
          ? allowRule['disabled'] !== 'true'
          : svc.length > 0 && svc.every((i) => i.active),
        memberCount: members.length,
      });
    }
    return out;
  }

  async listGroupMembers(name: string): Promise<AccessMember[]> {
    const out: AccessMember[] = [];
    const entries = await this.write('/ip/firewall/address-list/print', [`?list=noc-grp-${name}`]);
    for (const e of entries) {
      if (e['dynamic'] === 'true') continue; // runtime (hotspot/mac) tags aren't config
      const id = e['.id'];
      const addr = e['address'] ?? '';
      if (!id || !addr) continue;
      out.push({ id, kind: addr.includes('/') ? 'subnet' : 'ip', value: addr, source: 'static' });
    }
    const prefix = `NOC-MAC:${name}|`;
    const mangle = await this.write(`${this.MANGLE_TAG}/print`, ['?action=add-src-to-address-list']);
    for (const m of mangle) {
      const comment = (m['comment'] ?? '').trim();
      if (!comment.startsWith(prefix)) continue;
      const id = m['.id'];
      if (!id) continue;
      out.push({ id, kind: 'mac', value: m['src-mac-address'] ?? comment.slice(prefix.length), source: 'mac' });
    }
    return out;
  }

  async addGroupMac(name: string, mac: string): Promise<void> {
    const MAC = mac.toUpperCase(); // RouterOS stores MACs uppercase — match to avoid dupes
    const comment = `NOC-MAC:${name}|${MAC}`;
    const rows = await this.write(`${this.MANGLE_TAG}/print`, ['?action=add-src-to-address-list']);
    if (rows.some((r) => (r['comment'] ?? '').trim() === comment)) return;
    await this.write(`${this.MANGLE_TAG}/add`, [
      '=chain=prerouting',
      `=src-mac-address=${MAC}`,
      '=action=add-src-to-address-list',
      `=address-list=noc-grp-${name}`,
      // 10m (not 1h): RouterOS won't let us delete the dynamic group entry this rule
      // creates, so a shorter rolling timeout bounds how long a removed MAC lingers in
      // the group (active devices re-tag on their next packet).
      '=address-list-timeout=10m',
      `=comment=${comment}`,
    ]);
  }

  async removeGroupMac(name: string, mac: string): Promise<void> {
    const comment = `NOC-MAC:${name}|${mac.toUpperCase()}`;
    const rows = await this.write(`${this.MANGLE_TAG}/print`, ['?action=add-src-to-address-list']);
    for (const r of rows) {
      if ((r['comment'] ?? '').trim() !== comment) continue;
      const id = r['.id'];
      if (id) await this.write(`${this.MANGLE_TAG}/remove`, [`=.id=${id}`]);
    }
  }

  async deleteAccessProfile(name: string): Promise<void> {
    // 1) blocklist service intents for this group (+ its QUIC infra, via removeIntent)
    const intents = await this.listBlockIntents();
    for (const i of intents) if (i.group === name) await this.removeIntent(`${name}|${i.service}`);
    // 2) allowlist deny-all rule (Phase 2), by comment
    const chain = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    for (const r of chain) {
      if ((r['comment'] ?? '').trim() !== `NOC-ALLOW:${name}`) continue;
      const id = r['.id'];
      if (id) await this.write('/ip/firewall/filter/remove', [`=.id=${id}`]);
    }
    // 3) MAC-tag mangle rules
    const prefix = `NOC-MAC:${name}|`;
    const mangle = await this.write(`${this.MANGLE_TAG}/print`, ['?action=add-src-to-address-list']);
    for (const m of mangle) {
      if (!(m['comment'] ?? '').trim().startsWith(prefix)) continue;
      const id = m['.id'];
      if (id) await this.write(`${this.MANGLE_TAG}/remove`, [`=.id=${id}`]);
    }
    // 4) static group + allow-list members (dynamic entries expire on their own)
    for (const list of [`noc-grp-${name}`, `noc-allow-${name}`]) {
      const entries = await this.write('/ip/firewall/address-list/print', [`?list=${list}`]);
      for (const e of entries) {
        if (e['dynamic'] === 'true') continue;
        const id = e['.id'];
        if (id) await this.write('/ip/firewall/address-list/remove', [`=.id=${id}`]);
      }
    }
    // 5) unbind the hotspot user-profile (keep it for user assignment) — but ONLY if it
    //    still points at OUR list, so we never blank a binding we don't own.
    const profs = await this.write('/ip/hotspot/user/profile/print', [`?name=${name}`]);
    for (const p of profs) {
      if (p['name'] !== name) continue;
      if ((p['address-list'] ?? '') !== `noc-grp-${name}`) continue;
      const id = p['.id'];
      if (id) await this.write('/ip/hotspot/user/profile/set', [`=.id=${id}`, '=address-list=']);
    }
  }

  // ---- Allowlist mode (default-deny: only local + DNS + allowed dests reach out) ----

  private allowList(name: string): string {
    return `noc-allow-${name}`;
  }

  /** Seed the always-allowed set into noc-allow-<name>: RFC1918 (intra-LAN) + DNS
   *  (the router's configured servers + common public resolvers). Without this the
   *  deny-all would sever LAN + name resolution. Idempotent; tagged NOC-ALLOW-LOCAL. */
  private async ensureAllowLocals(name: string): Promise<void> {
    const list = this.allowList(name);
    const rows = await this.write('/ip/firewall/address-list/print', [`?list=${list}`]);
    const have = new Set(
      rows.filter((r) => (r['comment'] ?? '').trim() === 'NOC-ALLOW-LOCAL').map((r) => r['address']),
    );
    const locals = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4'];
    const dns = await this.write('/ip/dns/print');
    const servers = (dns[0]?.['servers'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const addr of [...locals, ...servers]) {
      if (!have.has(addr)) {
        await this.write('/ip/firewall/address-list/add', [`=list=${list}`, `=address=${addr}`, '=comment=NOC-ALLOW-LOCAL']);
      }
    }
  }

  async setAllowlist(name: string, allow: string[], enforce: boolean): Promise<void> {
    await this.ensureBlockChain();
    const list = this.allowList(name);
    await this.ensureAllowLocals(name);
    // Reconcile the user's allowed destinations (NOC-ALLOW-DEST), leaving locals intact.
    const rows = await this.write('/ip/firewall/address-list/print', [`?list=${list}`]);
    // Skip dynamic rows: an FQDN dest resolves into dynamic child entries that inherit
    // this comment; RouterOS rejects removing dynamic items, which would abort the whole
    // save (and, since the deny-all state is set last, could leave a lockout enforced).
    const dests = rows.filter((r) => r['dynamic'] !== 'true' && (r['comment'] ?? '').trim() === 'NOC-ALLOW-DEST');
    const want = new Set(allow);
    const have = new Set(dests.map((r) => r['address']));
    for (const r of dests) {
      const addr = r['address'];
      const id = r['.id'];
      if (addr && id && !want.has(addr)) await this.write('/ip/firewall/address-list/remove', [`=.id=${id}`]);
    }
    for (const addr of allow) {
      if (!have.has(addr)) {
        await this.write('/ip/firewall/address-list/add', [`=list=${list}`, `=address=${addr}`, '=comment=NOC-ALLOW-DEST']);
      }
    }
    // The deny-all drop: everything from this group NOT in noc-allow-<name>. Protocol-
    // agnostic so it also kills QUIC. Created/kept DISABLED unless enforce=true (staged).
    const comment = `NOC-ALLOW:${name}`;
    const chain = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    const existing = chain.find((r) => (r['comment'] ?? '').trim() === comment);
    if (existing && existing['.id']) {
      await this.write('/ip/firewall/filter/set', [`=.id=${existing['.id']}`, `=disabled=${enforce ? 'no' : 'yes'}`]);
    } else {
      await this.write('/ip/firewall/filter/add', [
        `=chain=${this.BLOCK_CHAIN}`,
        '=action=drop',
        `=src-address-list=noc-grp-${name}`,
        `=dst-address-list=!${list}`,
        `=disabled=${enforce ? 'no' : 'yes'}`,
        `=comment=${comment}`,
      ]);
    }
  }

  async removeAllowlist(name: string): Promise<void> {
    const comment = `NOC-ALLOW:${name}`;
    const chain = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    for (const r of chain) {
      if ((r['comment'] ?? '').trim() !== comment) continue;
      const id = r['.id'];
      if (id) await this.write('/ip/firewall/filter/remove', [`=.id=${id}`]);
    }
    const rows = await this.write('/ip/firewall/address-list/print', [`?list=${this.allowList(name)}`]);
    for (const e of rows) {
      if (e['dynamic'] === 'true') continue;
      const id = e['.id'];
      if (id) await this.write('/ip/firewall/address-list/remove', [`=.id=${id}`]);
    }
  }

  async listSimpleQueues(): Promise<SimpleQueueDTO[]> {
    const res = await this.write('/queue/simple/print');
    return res.map((r) => {
      const name = r['name'] ?? '';
      return {
        id: r['.id'] ?? '',
        name,
        target: r['target'] ?? '',
        maxLimit: r['max-limit'] ?? '0/0',
        bytes: r['bytes'] ?? '0/0',
        disabled: r['disabled'] === 'true',
        dynamic: r['dynamic'] === 'true',
        hotspot: name.startsWith('<hotspot'),
      };
    });
  }

  async addSimpleQueue(input: AddSimpleQueueInput): Promise<void> {
    await this.write('/queue/simple/add', [
      `=name=${input.name}`,
      `=target=${input.target}`,
      `=max-limit=${input.maxLimit}`,
    ]);
  }

  async setSimpleQueueMax(id: string, maxLimit: string): Promise<void> {
    await this.write('/queue/simple/set', [`=.id=${id}`, `=max-limit=${maxLimit}`]);
  }

  async removeSimpleQueue(id: string): Promise<void> {
    await this.write('/queue/simple/remove', [`=.id=${id}`]);
  }

  async listDhcpLeases(): Promise<DhcpLeaseDTO[]> {
    const res = await this.write('/ip/dhcp-server/lease/print');
    return res.map((r) => ({
      id: r['.id'] ?? '',
      address: r['address'] ?? '',
      macAddress: r['mac-address'] ?? '',
      hostName: r['host-name'] ?? null,
      rateLimit: (r['rate-limit'] ?? '').trim() || null,
      dynamic: r['dynamic'] === 'true',
      server: r['server'] ?? null,
      status: r['status'] ?? null,
    }));
  }

  async setLeaseRateLimit(id: string, rateLimit: string): Promise<void> {
    // A dynamic lease can't be edited persistently — pin it static first
    // (best-effort; errors if already static). Then set (or clear) the limit.
    try {
      await this.write('/ip/dhcp-server/lease/make-static', [`=.id=${id}`]);
    } catch {
      /* already static — fine */
    }
    await this.write('/ip/dhcp-server/lease/set', [`=.id=${id}`, `=rate-limit=${rateLimit}`]);
  }

  // ---- Diagnostics & remediation --------------------------------------------

  async pingHost(ip: string, count = 4): Promise<PingResult> {
    // `count` terminates the command; each probe emits a row (with `time` on a
    // reply, or `status`/no time on a timeout).
    const rows = await this.write('/ping', [`=address=${ip}`, `=count=${count}`]);
    const times: number[] = [];
    let received = 0;
    for (const r of rows) {
      const ms = parseMs(r['time']);
      if (r['time'] && ms != null) {
        received++;
        times.push(ms);
      }
    }
    const sent = rows.length || count;
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    return {
      sent,
      received,
      lossPct: sent > 0 ? Math.round(((sent - received) / sent) * 100) : 0,
      avgMs: avg != null ? Math.round(avg * 100) / 100 : null,
      minMs: times.length ? Math.min(...times) : null,
      maxMs: times.length ? Math.max(...times) : null,
    };
  }

  async tracePath(ip: string): Promise<TraceHop[]> {
    // Bounded so an unreachable target can't hang the connection: one round,
    // short per-hop timeout, capped hops.
    const rows = await this.write('/tool/traceroute', [
      `=address=${ip}`,
      '=count=1',
      '=timeout=1s',
      '=max-hops=12',
    ]);
    return rows.map((r, i) => ({
      hop: i + 1,
      address: r['address'] ?? '',
      avgMs: parseMs(r['avg'] ?? r['last']),
      lossPct: parsePct(r['loss']),
    }));
  }

  async deviceNetInfo(ip: string): Promise<DeviceNetInfo> {
    const [arpRows, leaseRows] = await Promise.all([
      this.write('/ip/arp/print', [`?address=${ip}`]).catch(() => [] as Row[]),
      this.write('/ip/dhcp-server/lease/print', [`?address=${ip}`]).catch(() => [] as Row[]),
    ]);
    const a = arpRows[0];
    const arp = a
      ? { macAddress: a['mac-address'] ?? '', interface: a['interface'] ?? '', dynamic: a['dynamic'] === 'true' }
      : null;
    const l = leaseRows[0];
    const lease = l
      ? {
          hostName: l['host-name'] ?? null,
          macAddress: l['mac-address'] ?? '',
          server: l['server'] ?? null,
          status: l['status'] ?? null,
          expiresAfter: l['expires-after'] ?? null,
        }
      : null;

    // The ARP interface is often a bridge; resolve the real egress port via the
    // bridge host table so PoE actions target the physical ethernet.
    let port: string | null = arp?.interface || null;
    const mac = arp?.macAddress || lease?.macAddress;
    if (mac) {
      try {
        const hosts = await this.write('/interface/bridge/host/print', [`?mac-address=${mac}`]);
        const on = hosts.find((h) => h['on-interface'])?.['on-interface'];
        if (on) port = on;
      } catch {
        /* not bridged — keep the ARP interface */
      }
    }

    // PoE state, only if `port` is a PoE-capable ethernet.
    let poe: DeviceNetInfo['poe'] = null;
    if (port) {
      try {
        const poeRows = await this.write('/interface/ethernet/poe/print', [`?name=${port}`]);
        if (poeRows[0]) {
          let status: string | null = poeRows[0]['poe-out'] ?? null;
          let power: string | null = null;
          try {
            const mon = await this.write('/interface/ethernet/poe/monitor', [
              `=numbers=${port}`,
              '=once=',
            ]);
            status = mon[0]?.['poe-out-status'] ?? status;
            power = mon[0]?.['poe-out-power'] ?? null;
          } catch {
            /* monitor unsupported — fall back to the poe-out setting */
          }
          poe = { name: port, status, power };
        }
      } catch {
        /* port is not PoE-capable */
      }
    }
    return { arp, lease, port, poe };
  }

  async recentLog(limit = 40): Promise<RouterLogEntry[]> {
    const rows = await this.write('/log/print');
    // /log is oldest→newest; take the tail.
    return rows.slice(-limit).reverse().map((r) => ({
      time: r['time'] ?? '',
      topics: r['topics'] ?? '',
      message: r['message'] ?? '',
    }));
  }

  async poePowerCycle(port: string): Promise<void> {
    const poeRows = await this.write('/interface/ethernet/poe/print', [`?name=${port}`]);
    const id = poeRows[0]?.['.id'];
    if (!id) throw new Error(`Port ${port} bukan port PoE`);
    await this.write('/interface/ethernet/poe/power-cycle', [`=.id=${id}`, '=duration=00:00:05']);
  }

  async saveBackup(name: string): Promise<void> {
    await this.write('/system/backup/save', [`=name=${name}`]);
  }

  async close(): Promise<void> {
    if (this.conn && this.connected) {
      try {
        await this.conn.close();
      } catch {
        /* ignore close errors */
      }
    }
    this.connected = false;
    this.conn = null;
  }

  private hotspotParams(input: Partial<AddHotspotUserInput>): string[] {
    const p: string[] = [];
    if (input.name != null) p.push(`=name=${input.name}`);
    if (input.password != null) p.push(`=password=${input.password}`);
    if (input.profile) p.push(`=profile=${input.profile}`);
    if (input.server) p.push(`=server=${input.server}`);
    // != null so an empty string CLEARS the limit (0s / 0 = unlimited in
    // RouterOS); undefined leaves the current value untouched on updates.
    if (input.limitUptime != null) p.push(`=limit-uptime=${input.limitUptime === '' ? '0s' : input.limitUptime}`);
    if (input.limitBytesTotal != null)
      p.push(`=limit-bytes-total=${input.limitBytesTotal === '' ? '0' : input.limitBytesTotal}`);
    if (input.comment != null) p.push(`=comment=${input.comment}`);
    return p;
  }

  private profileParams(input: Partial<UpsertHotspotProfileInput>): string[] {
    const p: string[] = [];
    if (input.name != null) p.push(`=name=${input.name}`);
    if (input.rateLimit) p.push(`=rate-limit=${input.rateLimit}`);
    if (input.sharedUsers) p.push(`=shared-users=${input.sharedUsers}`);
    if (input.sessionTimeout) p.push(`=session-timeout=${input.sessionTimeout}`);
    // != null (not truthy) so an empty string CLEARS the binding (un-links a profile).
    if (input.addressList != null) p.push(`=address-list=${input.addressList}`);
    return p;
  }
}
