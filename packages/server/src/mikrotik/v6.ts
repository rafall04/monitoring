// =============================================================================
// RouterOS v6 adapter using the binary API (node-routeros, ports 8728/8729).
// Lazily connects on first use and reuses the connection until close().
// Results from the binary API are untyped rows; we map them to our DTOs.
// =============================================================================

import { RouterOSAPI } from 'node-routeros';
import type {
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

export class RouterOsV6Client implements MikrotikClient {
  private conn: RouterOSAPI | null = null;
  private connected = false;
  private readonly cfg: MikrotikConfig;

  constructor(cfg: MikrotikConfig) {
    this.cfg = cfg;
  }

  private async api(): Promise<RouterOSAPI> {
    if (this.conn && this.connected) return this.conn;
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

  async listNetwatch(): Promise<NetwatchEntry[]> {
    const res = await this.write('/tool/netwatch/print');
    return res.map((r) => ({
      id: r['.id'],
      host: r['host'] ?? '',
      status: (r['status'] as NetwatchEntry['status']) ?? 'unknown',
      since: r['since'],
      comment: r['comment'],
      name: r['name'],
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
    }));
  }

  async listHotspotUsers(): Promise<HotspotUser[]> {
    const res = await this.write('/ip/hotspot/user/print');
    return res.map((r) => ({
      '.id': r['.id'],
      name: r['name'] ?? '',
      profile: r['profile'],
      server: r['server'],
      'limit-uptime': r['limit-uptime'],
      'limit-bytes-total': r['limit-bytes-total'],
      uptime: r['uptime'],
      'bytes-in': r['bytes-in'],
      'bytes-out': r['bytes-out'],
      comment: r['comment'],
      disabled: r['disabled'],
    }));
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

  async ensureBlockChain(): Promise<void> {
    const fwd = await this.write('/ip/firewall/filter/print', ['?chain=forward']);
    if (fwd.some((r) => r['action'] === 'jump' && r['jump-target'] === this.BLOCK_CHAIN)) return;
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

  async listBlockIntents(): Promise<BlockIntent[]> {
    const rows = await this.write('/ip/firewall/filter/print', [`?chain=${this.BLOCK_CHAIN}`]);
    return rows.map((r) => {
      const m = /^NOC:([^|]+)\|(.+)$/.exec((r['comment'] ?? '').trim());
      return {
        id: r['.id'] ?? '',
        group: m?.[1] ?? 'semua',
        service: m?.[2] ?? ((r['dst-address-list'] ?? '').replace('noc-svc-', '') || '?'),
        active: r['disabled'] !== 'true',
      };
    });
  }

  async ensureServiceDomains(service: string, domains: string[]): Promise<void> {
    const list = `noc-svc-${service}`;
    const rows = await this.write('/ip/firewall/address-list/print', [`?list=${list}`]);
    const have = new Set(rows.map((r) => r['address']));
    for (const d of domains) {
      if (!have.has(d)) {
        await this.write('/ip/firewall/address-list/add', [
          `=list=${list}`,
          `=address=${d}`,
          '=comment=NOC svc',
        ]);
      }
    }
  }

  async createIntent(input: { group: string; service: string }): Promise<void> {
    const params = [
      `=chain=${this.BLOCK_CHAIN}`,
      '=action=drop',
      `=dst-address-list=noc-svc-${input.service}`,
      `=comment=NOC:${input.group}|${input.service}`,
    ];
    if (input.group !== 'semua') params.push(`=src-address-list=noc-grp-${input.group}`);
    await this.write('/ip/firewall/filter/add', params);
  }

  async setIntentActive(id: string, active: boolean): Promise<void> {
    await this.write('/ip/firewall/filter/set', [`=.id=${id}`, `=disabled=${active ? 'no' : 'yes'}`]);
  }

  async removeIntent(id: string): Promise<void> {
    await this.write('/ip/firewall/filter/remove', [`=.id=${id}`]);
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
    if (input.limitUptime) p.push(`=limit-uptime=${input.limitUptime}`);
    if (input.limitBytesTotal) p.push(`=limit-bytes-total=${input.limitBytesTotal}`);
    if (input.comment != null) p.push(`=comment=${input.comment}`);
    return p;
  }

  private profileParams(input: Partial<UpsertHotspotProfileInput>): string[] {
    const p: string[] = [];
    if (input.name != null) p.push(`=name=${input.name}`);
    if (input.rateLimit) p.push(`=rate-limit=${input.rateLimit}`);
    if (input.sharedUsers) p.push(`=shared-users=${input.sharedUsers}`);
    if (input.sessionTimeout) p.push(`=session-timeout=${input.sessionTimeout}`);
    return p;
  }
}
