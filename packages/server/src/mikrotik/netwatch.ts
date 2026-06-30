// =============================================================================
// Netwatch script generator.
//
// We use URL query parameters (not a JSON body) so the generated RouterOS script
// has NO inner quotes to escape -> identical text works both for copy-paste in
// the terminal and for automatic install via the binary API.
//
// Timing (interval/timeout) and the Telegram message text + optional custom
// RouterOS tail are read from the global Setting singleton via NetwatchConfig
// (passed in by the caller — keep this module pure / no DB import).
// =============================================================================

import { renderTemplate } from '@noc/shared';

export interface NetwatchScriptParams {
  /** Public base URL of the backend reachable by the router, e.g. https://noc.example.com */
  webhookBaseUrl: string;
  routerId: string;
  token: string;
  host: string; // device IP the Netwatch entry watches
  deviceName?: string;
  /** Ping interval, e.g. "00:00:10". Overrides cfg.intervalSec when set. */
  interval?: string;
  /** When set (router mode + critical device), the script alerts Telegram directly. */
  telegram?: { botToken: string; chatId: string; siteName: string };
  /** Global Settings — controls timing + custom RouterOS tail + TG templates. */
  cfg?: NetwatchConfig;
}

/** Subset of the global Setting consumed by the script generator. */
export interface NetwatchConfig {
  intervalSec: number;
  timeoutMs: number;
  extraUp: string | null;
  extraDown: string | null;
  telegramDownTemplate: string;
  telegramUpTemplate: string;
}

const DEFAULT_CFG: NetwatchConfig = {
  intervalSec: 10,
  timeoutMs: 1000,
  extraUp: null,
  extraDown: null,
  telegramDownTemplate: '🔴 DOWN — {device} ({ip})\n🏭 {site}',
  telegramUpTemplate: '🟢 RECOVERED — {device} ({ip})\n🏭 {site}',
};

function intervalString(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function webhookUrl(p: NetwatchScriptParams, status: 'up' | 'down'): string {
  const base = p.webhookBaseUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams({
    host: p.host,
    status,
    router_id: p.routerId,
  }).toString();
  return `${base}/api/v1/webhook/netwatch?${qs}`;
}

/** The /tool fetch one-liner stored as up/down script (no inner quote escaping). */
export function fetchScript(p: NetwatchScriptParams, status: 'up' | 'down'): string {
  return [
    `/tool fetch url="${webhookUrl(p, status)}"`,
    `http-method=post`,
    // RouterOS `/tool fetch http-method=post` defaults to Content-Type:
    // application/octet-stream, which Fastify rejects with 415 (no parser). We
    // send no body — all params are in the query string — so pin a Content-Type
    // the backend accepts. (The backend also tolerates any type defensively.)
    `http-header-field="X-Webhook-Token: ${p.token},Content-Type: text/plain"`,
    `keep-result=no`,
  ].join(' ');
}

/** Optional direct-to-Telegram fetch (router mode). The message text is taken
 *  from the global Settings template so super_admin can customize it. */
export function telegramFetch(p: NetwatchScriptParams, status: 'up' | 'down'): string | null {
  if (!p.telegram) return null;
  const cfg = p.cfg ?? DEFAULT_CFG;
  const template = status === 'up' ? cfg.telegramUpTemplate : cfg.telegramDownTemplate;
  const text = renderTemplate(template, {
    device: p.deviceName ?? p.host,
    ip: p.host,
    site: p.telegram.siteName,
    status,
  });
  const url =
    `https://api.telegram.org/bot${p.telegram.botToken}/sendMessage` +
    `?chat_id=${encodeURIComponent(p.telegram.chatId)}&text=${encodeURIComponent(text)}`;
  // check-certificate=no: MikroTik often lacks the Telegram CA chain.
  return `/tool fetch url="${url}" keep-result=no check-certificate=no`;
}

/** Full up/down script body: webhook to NOC + optional Telegram + custom tail. */
export function scriptFor(p: NetwatchScriptParams, status: 'up' | 'down'): string {
  const cfg = p.cfg ?? DEFAULT_CFG;
  const extra = status === 'up' ? cfg.extraUp : cfg.extraDown;
  const parts = [fetchScript(p, status)];
  const tg = telegramFetch(p, status);
  if (tg) parts.push(tg);
  if (extra && extra.trim()) parts.push(extra.trim());
  return parts.join('\n');
}

/** Escape a script string for embedding inside a CLI `up-script="..."` argument. */
function escapeForCli(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * A ready-to-paste RouterOS CLI block that creates the Netwatch entry with
 * inline up/down scripts. Idempotent-ish: it removes a previous entry for the
 * same host first.
 */
export function generateNetwatchCli(p: NetwatchScriptParams): string {
  const cfg = p.cfg ?? DEFAULT_CFG;
  const interval = p.interval ?? intervalString(cfg.intervalSec);
  const timeoutMs = cfg.timeoutMs;
  const up = escapeForCli(scriptFor(p, 'up'));
  const down = escapeForCli(scriptFor(p, 'down'));
  const label = p.deviceName ? `${p.deviceName} (${p.host})` : p.host;
  return [
    `# NOC Netwatch for ${label}`,
    `:foreach i in=[/tool netwatch find where host="${p.host}"] do={/tool netwatch remove $i}`,
    `/tool netwatch add host=${p.host} interval=${interval} timeout=${timeoutMs}ms \\`,
    `    up-script="${up}" \\`,
    `    down-script="${down}" \\`,
    // Human-readable comment (the device name). NOC matches entries by host, not
    // comment, and the router-import path reads this back as the device name.
    `    comment="${escapeForCli(p.deviceName ?? p.host)}"`,
  ].join('\n');
}

/** Inputs for an automatic install via the binary API (no CLI escaping). */
export function netwatchApiInput(p: NetwatchScriptParams): {
  host: string;
  interval: string;
  timeout: string;
  upScript: string;
  downScript: string;
  comment: string;
} {
  const cfg = p.cfg ?? DEFAULT_CFG;
  return {
    host: p.host,
    interval: p.interval ?? intervalString(cfg.intervalSec),
    timeout: `${cfg.timeoutMs}ms`,
    upScript: scriptFor(p, 'up'),
    downScript: scriptFor(p, 'down'),
    // Human-readable comment (device name); entries are matched by host, and the
    // router-import path reads this comment back as the device name.
    comment: p.deviceName ?? p.host,
  };
}
