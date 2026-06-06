// =============================================================================
// RouterOS v6 adapter using the binary API (node-routeros, ports 8728/8729).
// Lazily connects on first use and reuses the connection until close().
// Results from the binary API are untyped rows; we map them to our DTOs.
// =============================================================================

import { RouterOSAPI } from 'node-routeros';
import type {
  HotspotActive,
  HotspotProfile,
  HotspotUser,
  RouterResource,
} from '@noc/shared';
import type {
  AddHotspotUserInput,
  AddNetwatchInput,
  MikrotikClient,
  MikrotikConfig,
  NetwatchEntry,
  UpsertHotspotProfileInput,
} from './types';

type Row = Record<string, string>;

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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
      server: r['server'],
    }));
  }

  async disconnectHotspotActive(id: string): Promise<void> {
    await this.write('/ip/hotspot/active/remove', [`=.id=${id}`]);
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
