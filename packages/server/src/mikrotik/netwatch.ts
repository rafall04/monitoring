// =============================================================================
// Netwatch script generator.
//
// We use URL query parameters (not a JSON body) so the generated RouterOS script
// has NO inner quotes to escape -> identical text works both for copy-paste in
// the terminal and for automatic install via the binary API.
// =============================================================================

export interface NetwatchScriptParams {
  /** Public base URL of the backend reachable by the router, e.g. https://noc.example.com */
  webhookBaseUrl: string;
  routerId: string;
  token: string;
  host: string; // device IP the Netwatch entry watches
  deviceName?: string;
  interval?: string; // default "00:00:10"
  /** When set (router mode + critical device), the script alerts Telegram directly. */
  telegram?: { botToken: string; chatId: string; siteName: string };
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
    `http-header-field="X-Webhook-Token: ${p.token}"`,
    `keep-result=no`,
  ].join(' ');
}

/** Optional direct-to-Telegram fetch (router mode). Message is fully pre-encoded
 *  at generation time, so device names with spaces are safe. */
export function telegramFetch(p: NetwatchScriptParams, status: 'up' | 'down'): string | null {
  if (!p.telegram) return null;
  const emoji = status === 'up' ? '🟢' : '🔴';
  const label = status === 'up' ? 'UP' : 'DOWN';
  const name = p.deviceName ?? p.host;
  const text = `${emoji} ${label} — ${name} (${p.host})\n🏭 ${p.telegram.siteName}`;
  const url =
    `https://api.telegram.org/bot${p.telegram.botToken}/sendMessage` +
    `?chat_id=${encodeURIComponent(p.telegram.chatId)}&text=${encodeURIComponent(text)}`;
  // check-certificate=no: MikroTik often lacks the Telegram CA chain.
  return `/tool fetch url="${url}" keep-result=no check-certificate=no`;
}

/** Full up/down script body: webhook to NOC + optional Telegram (router mode). */
export function scriptFor(p: NetwatchScriptParams, status: 'up' | 'down'): string {
  const parts = [fetchScript(p, status)];
  const tg = telegramFetch(p, status);
  if (tg) parts.push(tg);
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
  const interval = p.interval ?? '00:00:10';
  const up = escapeForCli(scriptFor(p, 'up'));
  const down = escapeForCli(scriptFor(p, 'down'));
  const label = p.deviceName ? `${p.deviceName} (${p.host})` : p.host;
  return [
    `# NOC Netwatch for ${label}`,
    `:foreach i in=[/tool netwatch find where host="${p.host}"] do={/tool netwatch remove $i}`,
    `/tool netwatch add host=${p.host} interval=${interval} \\`,
    `    up-script="${up}" \\`,
    `    down-script="${down}" \\`,
    `    comment="NOC:${p.routerId}"`,
  ].join('\n');
}

/** Inputs for an automatic install via the binary API (no CLI escaping). */
export function netwatchApiInput(p: NetwatchScriptParams): {
  host: string;
  interval: string;
  upScript: string;
  downScript: string;
  comment: string;
} {
  return {
    host: p.host,
    interval: p.interval ?? '00:00:10',
    upScript: scriptFor(p, 'up'),
    downScript: scriptFor(p, 'down'),
    comment: `NOC:${p.routerId}`,
  };
}
