import type { RuijiePortDTO } from '@noc/shared';
import type {
  RuijieClient,
  RuijieClientStation,
  RuijieConfig,
  RuijieDevice,
} from './types';

const DEFAULT_BASE_URL = 'https://cloud-as.ruijienetworks.com';
// Static API-gateway token observed on the public auth endpoint (validated live
// against a real account). Overridable if Ruijie ever rotates it.
const GATEWAY_TOKEN = process.env.RUIJIE_GATEWAY_TOKEN ?? 'd63dss0a81e4415a889ac5b78fsc904a';

const AUTH_PATH = '/service/api/oauth20/client/access_token';
const TREE_PATH = '/service/api/group/single/tree';
const DEVICES_PATH = '/service/api/maint/devices';
const CLIENTS_PATH = '/service/api/open/v1/dev/user/current-user';
const PORTS_PATH = '/service/api/maint/device/port';

export class RuijieApiError extends Error {
  constructor(
    public readonly code: number | string,
    message: string,
  ) {
    super(message);
    this.name = 'RuijieApiError';
  }
}

// Module-level token cache keyed by appId. Clients are constructed fresh per
// request (routes) and per poll tick (worker), so an instance-only cache would
// pay an auth POST — a quota-counted call — before every real call. Sharing the
// token here halves upstream volume; the transparent re-auth in get() clears a
// stale entry and retries, so expiry needs no TTL bookkeeping.
const tokenCache = new Map<string, string>();

/**
 * Ruijie Cloud OpenAPI client. Read-only. Auth is app_id + app_secret → a
 * short-lived accessToken passed as an `access_token` query param; the token is
 * cached and transparently refreshed once on an auth failure.
 */
export class RuijieCloudClient implements RuijieClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private token: string | null = null;
  private rootGroupId: string | number | null;

  constructor(private readonly cfg: RuijieConfig) {
    if (!cfg.appId || !cfg.appSecret) {
      throw new Error('RuijieCloudClient requires appId and appSecret');
    }
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
    this.rootGroupId = cfg.rootGroupId ?? null;
  }

  async close(): Promise<void> {
    this.token = null;
  }

  // ---- auth ----------------------------------------------------------------

  private async authenticate(): Promise<string> {
    const url = `${this.baseUrl}${AUTH_PATH}?token=${encodeURIComponent(GATEWAY_TOKEN)}`;
    const res = await this.fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appid: this.cfg.appId, secret: this.cfg.appSecret }),
    });
    const token: string | undefined = res?.accessToken ?? res?.data?.accessToken;
    if (!token) {
      throw new RuijieApiError(res?.code ?? -1, res?.msg ?? 'Ruijie auth failed (no token returned)');
    }
    this.token = token;
    tokenCache.set(this.cfg.appId ?? '', token);
    return token;
  }

  private async ensureToken(): Promise<string> {
    return this.token ?? tokenCache.get(this.cfg.appId ?? '') ?? (await this.authenticate());
  }

  // ---- HTTP ----------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchJson(url: string, init?: Parameters<typeof fetch>[1]): Promise<any> {
    let res;
    try {
      res = await fetch(url, { ...(init ?? {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new RuijieApiError('network', `Ruijie request failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new RuijieApiError(res.status, `Ruijie returned non-JSON (HTTP ${res.status})`);
    }
  }

  /** Authenticated GET with one transparent re-auth on a token failure. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async get(path: string, params: Record<string, string | number>): Promise<any> {
    const call = async () => {
      const token = await this.ensureToken();
      const qs = new URLSearchParams({ ...stringify(params), access_token: token });
      return this.fetchJson(`${this.baseUrl}${path}?${qs.toString()}`);
    };
    let json = await call();
    if (isAuthError(json)) {
      this.token = null;
      tokenCache.delete(this.cfg.appId ?? ''); // stale shared token — force re-auth
      json = await call();
    }
    if (json?.code !== undefined && json.code !== 0) {
      throw new RuijieApiError(json.code, json.msg ?? 'Ruijie API error');
    }
    return json;
  }

  private async resolveRootGroupId(): Promise<string | number> {
    if (this.rootGroupId != null) return this.rootGroupId;
    const json = await this.get(TREE_PATH, { depth: 'DEVICE' });
    const root = findRootGroup(json?.groups);
    if (root == null) throw new RuijieApiError('no-root', 'Could not resolve account ROOT group');
    this.rootGroupId = root;
    return root;
  }

  // ---- public API ----------------------------------------------------------

  async getDevices(): Promise<RuijieDevice[]> {
    const root = await this.resolveRootGroupId();
    const out: RuijieDevice[] = [];
    const perPage = 200;
    for (let page = 1; ; page += 1) {
      const json = await this.get(DEVICES_PATH, { group_id: root, page, per_page: perPage });
      const list: RawDevice[] = json?.deviceList ?? [];
      for (const d of list) out.push(mapDevice(d));
      if (list.length < perPage) break;
    }
    return out;
  }

  async getClients(groupId: number | string): Promise<RuijieClientStation[]> {
    const out: RuijieClientStation[] = [];
    const pageSize = 100;
    for (let pageIndex = 1; ; pageIndex += 1) {
      const json = await this.get(CLIENTS_PATH, {
        group_id: groupId,
        page_index: pageIndex,
        page_size: pageSize,
      });
      const list: RawStation[] = json?.list ?? json?.data?.list ?? [];
      for (const s of list) out.push(mapStation(s));
      const total: number = json?.totalCount ?? out.length;
      if (list.length < pageSize || out.length >= total) break;
    }
    return out;
  }

  async getPorts(serial: string): Promise<RuijiePortDTO[]> {
    const json = await this.get(PORTS_PATH, { sn: serial });
    const list: RawPort[] = json?.port ?? [];
    return list
      .map(mapPort)
      .sort((a, b) => a.port - b.port);
  }
}

// ---- raw response shapes + mappers ----------------------------------------

interface RawDevice {
  serialNumber?: string;
  aliasName?: string;
  name?: string;
  productClass?: string;
  groupId?: number;
  groupName?: string;
  onlineStatus?: string;
  staNums?: number;
  staActiveNums?: number;
  localIp?: string;
  cpeIp?: string;
  mac?: string;
  softwareVersion?: string;
  lastOnline?: number;
}

interface RawPort {
  name?: string;
  status?: string; // "Up" | "Down"
  port?: number;
  order?: number;
  panelOrder?: string;
  enable?: string; // "true" | "false" (switches only; APs omit it)
  speed?: string; // "1000M" | "100M" | "Unknown" (omitted when down on APs)
  mediumType?: string; // "Copper" | "Fiber" (switches only)
}

interface RawStation {
  mac?: string;
  ip?: string;
  userName?: string;
  linkedDevice?: string;
  deviceName?: string;
  ssid?: string;
  band?: string;
  rssi?: number;
  channel?: string;
  flowUp?: number;
  flowDown?: number;
  onlineTime?: number;
  manufacturer?: string;
  staOs?: string;
  staLabelName?: string;
}

function stringify(p: Record<string, string | number>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) o[k] = String(v);
  return o;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isAuthError(json: any): boolean {
  if (!json || json.code === 0 || json.code === undefined) return false;
  const msg = String(json.msg ?? '').toLowerCase();
  return /token|auth|unauthor|expire|login/.test(msg);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRootGroup(node: any): string | number | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'ROOT' && node.groupId != null) return node.groupId;
  for (const sub of node.subGroups ?? []) {
    const r = findRootGroup(sub);
    if (r != null) return r;
  }
  return null;
}

function mapDevice(d: RawDevice): RuijieDevice {
  return {
    serial: d.serialNumber ?? '',
    name: d.aliasName || d.name || d.serialNumber || '(unnamed)',
    model: d.productClass ?? null,
    groupId: d.groupId ?? 0,
    groupName: d.groupName ?? '',
    online: (d.onlineStatus ?? 'OFF') !== 'OFF',
    clientCount: d.staNums ?? 0,
    activeClients: d.staActiveNums ?? 0,
    localIp: d.localIp ?? null,
    wanIp: d.cpeIp ?? null,
    mac: d.mac ?? null,
    firmware: d.softwareVersion ?? null,
    lastOnline: d.lastOnline ?? null,
  };
}

function mapPort(p: RawPort, i: number): RuijiePortDTO {
  const speed = (p.speed ?? '').trim();
  return {
    name: p.name || `Port ${p.port ?? i + 1}`,
    port: p.port ?? p.order ?? i + 1,
    up: (p.status ?? '').toLowerCase() === 'up',
    speed: speed && speed.toLowerCase() !== 'unknown' ? speed : null,
    medium: p.mediumType ?? null,
    enabled: p.enable !== 'false', // APs omit `enable` → treat as enabled
  };
}

function mapStation(s: RawStation): RuijieClientStation {
  return {
    mac: s.mac ?? '',
    ip: s.ip ?? null,
    hostname: s.userName ?? null,
    apSerial: s.linkedDevice ?? null,
    apName: s.deviceName ?? null,
    ssid: s.ssid ?? null,
    band: s.band ?? null,
    rssi: s.rssi ?? null,
    channel: s.channel ?? null,
    flowUp: s.flowUp ?? null,
    flowDown: s.flowDown ?? null,
    onlineSince: s.onlineTime ?? null,
    manufacturer: s.manufacturer ?? null,
    os: s.staOs ?? null,
    category: s.staLabelName ?? null,
  };
}
