// =============================================================================
// Firewall config drift watch.
//
// Per router, per poll: snapshot /ip firewall nat|filter|mangle, diff against
// the canonical snapshot in Redis, and on ANY change emit:
//   - an audit_log row (queryable in the admin audit viewer),
//   - a `router.config` site event (live toast in the UI),
//   - Telegram + WhatsApp alerts on sites whose relay mode is "server".
//
// Why: a human disabling a dst-nat rule at 18:39 broke the China data feed
// for a night and nobody noticed — pings stayed green while the forward was
// dead. Watching the config itself closes that blind spot.
//
// NOC-managed rules are EXCLUDED (comment starting with "NOC", chains named
// noc-*) so the app's own block-engine writes never self-alert. Dynamic rules
// churn constantly and are excluded for the same reason. The first poll after
// baseline stores silently — enabling the watch must not page with the whole
// table as one giant "diff".
// =============================================================================

import type { RouterMikrotik } from '@prisma/client';
import { REDIS_KEYS } from '@noc/shared';
import type { StatusEngineDeps } from './status-engine';
import type { MikrotikClient } from './mikrotik/types';
import { publishSiteEvent } from './redis';
import { sendTelegram } from './notify';
import { decryptSecret } from './crypto';
import { enqueueWaMessage } from './wa';

const MENUS = ['nat', 'filter', 'mangle'] as const;
type Menu = (typeof MENUS)[number];

// RouterOS `print` embeds LIVE traffic counters on every rule — bytes/packets
// tick upward with normal traffic, so including them makes every poll produce
// a phantom diff (and an alert/audit storm). `last-seen`-style hit fields are
// volatile for the same reason. These fields are excluded from snapshots and
// diffs; real config fields are all that matter.
const VOLATILE_FIELDS = new Set(['bytes', 'packets', 'last-seen', 'last-hit-time']);

/** Rules the NOC itself manages — never alert on our own writes. */
function isNocManaged(row: Record<string, unknown>): boolean {
  const comment = String(row.comment ?? '');
  const chain = String(row.chain ?? '');
  return (
    comment.startsWith('NOC') ||
    chain.startsWith('noc-') ||
    row.dynamic === true ||
    row.dynamic === 'true'
  );
}

/** Canonical per-rule string: stable attributes sorted — order-insensitive. */
function canonical(row: Record<string, unknown>): string {
  return Object.keys(row)
    .filter((k) => k !== '.id' && !VOLATILE_FIELDS.has(k))
    .sort()
    .map((k) => `${k}=${String(row[k])}`)
    .join('|');
}

/** One-line human label for a rule, using whichever fields exist. */
function describe(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of [
    'chain',
    'action',
    'protocol',
    'src-address',
    'dst-address',
    'dst-port',
    'to-addresses',
    'to-ports',
    'src-address-list',
    'dst-address-list',
    'out-interface',
    'comment',
  ]) {
    const v = row[k];
    if (v !== undefined && v !== '') parts.push(`${k}=${String(v)}`);
  }
  return parts.join(' ');
}

/** Field-level diff of one rule pair, e.g. "disabled=false→true". */
function fieldChanges(
  oldRow: Record<string, unknown>,
  newRow: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(oldRow), ...Object.keys(newRow)]);
  keys.delete('.id');
  for (const k of keys) {
    if (VOLATILE_FIELDS.has(k)) continue;
    const a = oldRow[k];
    const b = newRow[k];
    const sa = a === undefined ? '—' : String(a);
    const sb = b === undefined ? '—' : String(b);
    if (sa !== sb) out.push(`${k}=${sa}→${sb}`);
  }
  return out;
}

export async function checkConfigDrift(
  deps: StatusEngineDeps,
  router: RouterMikrotik,
  client: MikrotikClient,
): Promise<void> {
  const snap: Partial<Record<Menu, Record<string, string>>> = {};
  const raw: Partial<Record<Menu, Map<string, Record<string, unknown>>>> = {};

  for (const menu of MENUS) {
    const rows = await client.listFirewallRaw(menu);
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      if (isNocManaged(r)) continue;
      const id = String(r['.id'] ?? '');
      if (id) byId.set(id, r);
    }
    raw[menu] = byId;
    const canonMap: Record<string, string> = {};
    for (const [id, r] of byId) canonMap[id] = canonical(r);
    snap[menu] = canonMap;
  }

  const key = REDIS_KEYS.routerCfgSnapshot(router.id);
  const prevRaw = await deps.redisPub.get(key);
  await deps.redisPub.set(key, JSON.stringify(snap));

  if (!prevRaw) {
    deps.logger.info({ routerId: router.id }, 'config drift baseline stored');
    return;
  }

  let prev: typeof snap;
  try {
    prev = JSON.parse(prevRaw) as typeof snap;
  } catch {
    return; // corrupt snapshot — already replaced, re-baseline next cycle
  }

  const changes: string[] = [];
  for (const menu of MENUS) {
    const before = prev[menu] ?? {};
    const now = snap[menu] ?? {};
    const rows = raw[menu]!;
    for (const id of Object.keys(now)) {
      if (!(id in before)) {
        changes.push(`+ ${menu} ${id} ${describe(rows.get(id)!)}`);
      } else if (before[id] !== now[id]) {
        // Field-level diff needs the OLD row too — canonical strings compare
        // but can't show which field moved, so re-derive from raw where we
        // still have it; for removed/missing raw, fall back to a marker.
        const delta = fieldChangesFromCanonical(before[id]!, now[id]!);
        changes.push(`~ ${menu} ${id} ${describe(rows.get(id)!)}: ${delta}`);
      }
    }
    for (const id of Object.keys(before)) {
      if (!(id in now)) changes.push(`- ${menu} ${id} ${before[id]!.slice(0, 160)}`);
    }
  }

  if (changes.length === 0) return;

  deps.logger.warn({ routerId: router.id, changes: changes.length }, 'router config drift detected');
  await deps.prisma.auditLog.create({
    data: {
      userId: null,
      action: 'router.config-change',
      entity: 'router',
      entityId: router.id,
      after: { siteId: router.siteId, changes },
    },
  });

  await publishSiteEvent(deps.redisPub, router.siteId, {
    type: 'router.config',
    siteId: router.siteId,
    routerId: router.id,
    routerName: router.name,
    changes,
  });

  const site = await deps.prisma.site.findUnique({
    where: { id: router.siteId },
    include: { waRecipients: { where: { isActive: true, alerts: true } } },
  });
  const shown = changes.slice(0, 12);
  const more = changes.length - shown.length;
  const text =
    `⚠️ CONFIG BERUBAH — ${site?.name ?? router.siteId} / ${router.name}\n` +
    shown.join('\n') +
    (more > 0 ? `\n(+${more} perubahan lainnya)` : '');

  if (site?.telegramMode === 'server' && site.telegramBotEncrypted && site.telegramChatId) {
    await sendTelegram(decryptSecret(site.telegramBotEncrypted), site.telegramChatId, text);
  }
  if (site?.whatsappMode === 'server') {
    for (const r of site.waRecipients) {
      await enqueueWaMessage(
        { prisma: deps.prisma, redis: deps.redisPub },
        { to: r.target, text, kind: 'alert', siteId: site.id },
      );
    }
  }
}

/**
 * Best-effort field diff from two canonical strings (key=value|key=value).
 * Values never contain '|' or '=' in practice for RouterOS API output — the
 * first '=' splits key from value and '|' only separates pairs.
 */
function fieldChangesFromCanonical(oldC: string, newC: string): string {
  const toMap = (s: string) => {
    const m = new Map<string, string>();
    for (const part of s.split('|')) {
      const i = part.indexOf('=');
      m.set(i === -1 ? part : part.slice(0, i), i === -1 ? '' : part.slice(i + 1));
    }
    return m;
  };
  const a = toMap(oldC);
  const b = toMap(newC);
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (VOLATILE_FIELDS.has(k)) continue;
    const va = a.get(k) ?? '—';
    const vb = b.get(k) ?? '—';
    if (va !== vb) out.push(`${k}=${va}→${vb}`);
  }
  return out.join(' ');
}
