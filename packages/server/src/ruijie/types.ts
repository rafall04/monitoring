// Ruijie (Reyee) Cloud OpenAPI integration. VALIDATED LIVE 2026-06-23 against a
// real account (region cloud-as). Deliberately separate from MikrotikClient —
// Reyee has no Netwatch/hotspot. The NOC needs three things:
//   1. device status + per-router connected-client COUNT  → one aggregated call
//   2. the per-room client station LIST (MAC/IP/…)         → on-demand drill-down
//   3. physical LAN/uplink PORT status (up/down + speed)   → on-demand drill-down

import type { RuijiePortDTO } from '@noc/shared';

/** One Reyee device (router/AP) from the Cloud /maint/devices call. */
export interface RuijieDevice {
  serial: string; // serialNumber
  name: string; // aliasName (falls back to name/serial)
  model: string | null; // productClass, e.g. "EW1300G"
  groupId: number; // BUILDING group the device lives in
  groupName: string;
  online: boolean; // onlineStatus !== "OFF"
  clientCount: number; // staNums — connected stations (the count we want)
  activeClients: number; // staActiveNums — actively-transmitting stations
  localIp: string | null;
  wanIp: string | null; // cpeIp
  mac: string | null;
  firmware: string | null; // softwareVersion
  lastOnline: number | null; // epoch ms
}

/** One connected client station (on-demand drill-down via /current-user). */
export interface RuijieClientStation {
  mac: string;
  ip: string | null;
  hostname: string | null; // userName
  apSerial: string | null; // linkedDevice — serial of the serving AP/router
  apName: string | null; // deviceName
  ssid: string | null;
  band: string | null; // "2.4G" | "5G"
  rssi: number | null;
  channel: string | null;
  flowUp: number | null; // bytes
  flowDown: number | null;
  onlineSince: number | null; // onlineTime (epoch ms)
  manufacturer: string | null;
  os: string | null; // staOs
  category: string | null; // staLabelName, e.g. "Smartphone"
}

export interface RuijieClient {
  /**
   * Whole-account fleet in ONE aggregated call (queried at the account ROOT
   * group): each device's online status AND its connected-client count
   * (staNums). The efficient steady-poll source — ~1 call covers every router
   * across every project, so per-minute polling stays far under the 5,000/day cap.
   */
  getDevices(): Promise<RuijieDevice[]>;
  /**
   * Connected client stations for ONE building group. The clients endpoint does
   * NOT aggregate at LOCATION/ROOT (those return 0) — it is per-building, so use
   * this for ON-DEMAND drill-down only, never steady polling.
   */
  getClients(groupId: number | string): Promise<RuijieClientStation[]>;
  /**
   * Physical LAN/uplink port status for ONE device (by serial): link up/down +
   * negotiated speed. VALIDATED LIVE 2026-07-01 on EW1300G (LAN1/2/3-IPTV) and
   * ES208GC switches (Port 1..8). Per-SN call — on-demand drill-down only.
   */
  getPorts(serial: string): Promise<RuijiePortDTO[]>;
  close(): Promise<void>;
}

export type RuijieDriver = 'cloud' | 'local';

export interface RuijieConfig {
  driver: RuijieDriver;
  timeoutMs?: number;

  // --- cloud driver (Ruijie Cloud OpenAPI) ---
  appId?: string;
  appSecret?: string;
  /** Region base URL. Default cloud-as (Asia). */
  baseUrl?: string;
  /** Account ROOT group id. Auto-discovered from the group tree when omitted. */
  rootGroupId?: number | string;
}
