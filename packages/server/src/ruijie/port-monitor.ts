// =============================================================================
// Ruijie port convergence point. The ONLY place a sampled port's state is
// reconciled into the DB — analogous to the device status-engine. Catches a
// wired link SILENTLY renegotiating below its known-good speed (a gigabit uplink
// dropping to 100M/10M on a failing cable/SFP), which ping and Netwatch miss
// because the link is still "up". Also tracks link flapping (loose cable).
//
// On a meaningful change it updates the RuijiePort row, appends a RuijiePortEvent
// (the durable timeline that drives the UI + weekly report), and fires a
// best-effort Telegram alert to the mapped site (if one is configured). Always
// records the event even when no Telegram target exists, so the app surface
// still shows it.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { RuijiePortDTO } from '@noc/shared';
import { decryptSecret } from '../crypto';
import { sendTelegram } from '../notify';
import type { Redis } from '../redis';

export interface PortMonitorDeps {
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger;
}

/** Router context needed to reconcile + route an alert. */
export interface PortRouterCtx {
  id: string;
  name: string;
  groupName: string;
  siteId: string | null; // resolved from account.groupSiteMap (may be null)
}

export type PortEventKind = 'degraded' | 'recovered' | 'link-down' | 'link-up';

// Two consecutive slow reads before we call it degraded — absorbs a one-off
// renegotiation blip (a port can momentarily come up at 100M then settle at 1G).
const DEBOUNCE_SLOW = 2;
/** Flap = this many link-downs within the window ⇒ "loose cable". Exported so
 *  the health endpoint classifies "flapping" with the exact same rule. */
export const RUIJIE_FLAP_WINDOW_MS = 60 * 60 * 1000;
export const RUIJIE_FLAP_THRESHOLD = 4;
const COOLDOWN_SEC = 300; // per port+kind Telegram cooldown

/** "1000M"/"100M"/"1.2G" → Mbit; null/"Unknown"/down → 0. */
export function speedToMbit(speed: string | null | undefined): number {
  const m = /^([\d.]+)\s*(M|G)$/i.exec((speed ?? '').trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2]!.toUpperCase() === 'G' ? 1000 : 1));
}

/** 1000 → "1G", 2500 → "2.5G", 100 → "100M", 0 → "—". */
export function mbitLabel(mbit: number): string {
  if (mbit <= 0) return '—';
  if (mbit >= 1000) return `${Math.round((mbit / 1000) * 10) / 10}G`;
  return `${mbit}M`;
}

export interface PortReconcileResult {
  degraded: number;
  recovered: number;
  flaps: number;
}

/**
 * Reconcile one router's freshly-sampled ports. Returns how many transitions
 * fired (for logging). Never throws into the poller — logs and continues.
 */
export async function reconcileRouterPorts(
  deps: PortMonitorDeps,
  router: PortRouterCtx,
  ports: RuijiePortDTO[],
): Promise<PortReconcileResult> {
  const result: PortReconcileResult = { degraded: 0, recovered: 0, flaps: 0 };
  const existing = await deps.prisma.ruijiePort.findMany({ where: { routerId: router.id } });
  const byName = new Map(existing.map((p) => [p.portName, p]));

  for (const dto of ports) {
    try {
      const changed = await reconcileOnePort(deps, router, dto, byName.get(dto.name) ?? null);
      if (changed === 'degraded') result.degraded += 1;
      else if (changed === 'recovered') result.recovered += 1;
      else if (changed === 'flap') result.flaps += 1;
    } catch (err) {
      deps.logger.warn(
        { router: router.name, port: dto.name, err: (err as Error).message },
        'ruijie port reconcile failed',
      );
    }
  }
  return result;
}

type PrevPort = NonNullable<Awaited<ReturnType<PrismaClient['ruijiePort']['findFirst']>>>;

async function reconcileOnePort(
  deps: PortMonitorDeps,
  router: PortRouterCtx,
  dto: RuijiePortDTO,
  prev: PrevPort | null,
): Promise<'degraded' | 'recovered' | 'flap' | null> {
  const now = new Date();
  const up = dto.up;
  const speedMbit = up ? speedToMbit(dto.speed) : 0;

  // Baseline = known-good speed. Learn upward only (never auto-lower — the drop
  // is exactly what we want to catch); a pinned baseline is left untouched.
  const prevBaseline = prev?.baselineMbit ?? 0;
  const pinned = prev?.baselinePinned ?? false;
  const baselineMbit = pinned ? prevBaseline : Math.max(prevBaseline, up ? speedMbit : 0);

  // Link flap: up<->down transition.
  const prevUp = prev?.up ?? up; // first sight: no transition
  const linkChanged = prev != null && prevUp !== up;
  let outcome: 'degraded' | 'recovered' | 'flap' | null = null;

  // Degradation state machine (only meaningful while up with a known baseline).
  let degraded = prev?.degraded ?? false;
  let degradedSince = prev?.degradedSince ?? null;
  let pendingSlow = prev?.pendingSlow ?? 0;

  if (up && baselineMbit > 0 && speedMbit > 0 && speedMbit < baselineMbit) {
    pendingSlow = (prev?.pendingSlow ?? 0) + 1;
    if (!degraded && pendingSlow >= DEBOUNCE_SLOW) {
      degraded = true;
      degradedSince = now;
      outcome = 'degraded';
    }
  } else if (up && speedMbit >= baselineMbit) {
    pendingSlow = 0;
    if (degraded) {
      degraded = false;
      degradedSince = null;
      outcome = 'recovered';
    }
  } else {
    // Down or unknown speed: not "slow", just reset the debounce. Keep the
    // degraded flag frozen so a flapping-then-slow port doesn't lose its mark.
    pendingSlow = 0;
  }

  // Persist current state (+ learned baseline + flap bookkeeping).
  const linkDowns = (prev?.linkDowns ?? 0) + (linkChanged && !up ? 1 : 0);
  await deps.prisma.ruijiePort.upsert({
    where: { routerId_portName: { routerId: router.id, portName: dto.name } },
    create: {
      routerId: router.id,
      portName: dto.name,
      portIndex: dto.port,
      medium: dto.medium,
      up,
      speedMbit,
      enabled: dto.enabled,
      baselineMbit,
      degraded,
      degradedSince,
      pendingSlow,
      lastLinkChangeAt: linkChanged ? now : null,
      linkDowns,
      lastSeenAt: now,
    },
    update: {
      portIndex: dto.port,
      medium: dto.medium,
      up,
      speedMbit,
      enabled: dto.enabled,
      baselineMbit,
      degraded,
      degradedSince,
      pendingSlow,
      ...(linkChanged ? { lastLinkChangeAt: now } : {}),
      linkDowns,
      lastSeenAt: now,
    },
  });

  // Emit events + alerts for transitions.
  if (linkChanged) {
    await recordEvent(deps, router, dto.name, up ? 'link-up' : 'link-down', {
      toMbit: up ? speedMbit : 0,
    });
    if (!up) {
      const flapping = await checkFlap(deps, router, dto.name);
      if (flapping) outcome = outcome ?? 'flap';
    }
  }

  if (outcome === 'degraded') {
    await recordEvent(deps, router, dto.name, 'degraded', { fromMbit: baselineMbit, toMbit: speedMbit });
    await alert(
      deps,
      router,
      dto.name,
      'degraded',
      `⚠️ PORT LAMBAT — ${router.name} ${dto.name}\nTurun ke ${mbitLabel(speedMbit)} (normal ${mbitLabel(baselineMbit)})\n🏭 ${router.groupName}`,
    );
  } else if (outcome === 'recovered') {
    await recordEvent(deps, router, dto.name, 'recovered', { toMbit: speedMbit });
    await alert(
      deps,
      router,
      dto.name,
      'recovered',
      `🟢 PORT NORMAL — ${router.name} ${dto.name}\nKembali ke ${mbitLabel(speedMbit)}\n🏭 ${router.groupName}`,
    );
  } else if (outcome === 'flap') {
    const n = await flapCount(deps, router.id, dto.name);
    await alert(
      deps,
      router,
      dto.name,
      'flap',
      `🔁 PORT FLAPPING — ${router.name} ${dto.name}\n${n}x putus dalam 1 jam (kabel/konektor?)\n🏭 ${router.groupName}`,
    );
  }

  return outcome;
}

async function flapCount(deps: PortMonitorDeps, routerId: string, portName: string): Promise<number> {
  return deps.prisma.ruijiePortEvent.count({
    where: { routerId, portName, kind: 'link-down', at: { gte: new Date(Date.now() - RUIJIE_FLAP_WINDOW_MS) } },
  });
}

/** True once link-downs in the window cross the flap threshold. */
async function checkFlap(deps: PortMonitorDeps, router: PortRouterCtx, portName: string): Promise<boolean> {
  const n = await flapCount(deps, router.id, portName);
  return n >= RUIJIE_FLAP_THRESHOLD;
}

async function recordEvent(
  deps: PortMonitorDeps,
  router: PortRouterCtx,
  portName: string,
  kind: PortEventKind,
  speeds: { fromMbit?: number; toMbit?: number },
): Promise<void> {
  await deps.prisma.ruijiePortEvent.create({
    data: {
      routerId: router.id,
      portName,
      kind,
      fromMbit: speeds.fromMbit ?? null,
      toMbit: speeds.toMbit ?? null,
    },
  });
}

/**
 * Best-effort Telegram to the router's mapped site (server-mode only). A port
 * that isn't mapped to a site still records its event above — it just doesn't
 * page. Cooldown suppresses repeat alerts for the same port+kind.
 */
async function alert(
  deps: PortMonitorDeps,
  router: PortRouterCtx,
  portName: string,
  kind: PortEventKind | 'flap',
  text: string,
): Promise<void> {
  try {
    if (!router.siteId) return;
    const site = await deps.prisma.site.findUnique({ where: { id: router.siteId } });
    if (!site || site.telegramMode !== 'server' || !site.telegramBotEncrypted || !site.telegramChatId)
      return;
    const fresh = await deps.redis.set(
      `noc:ruijie:portcooldown:${router.id}:${portName}:${kind}`,
      '1',
      'EX',
      COOLDOWN_SEC,
      'NX',
    );
    if (fresh !== 'OK') return;
    const ok = await sendTelegram(decryptSecret(site.telegramBotEncrypted), site.telegramChatId, text);
    deps.logger.info({ router: router.name, port: portName, kind, ok }, 'ruijie port alert sent');
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message }, 'ruijie port alert failed');
  }
}
