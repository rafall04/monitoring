// =============================================================================
// Interface-watch ("uplink") devices: work-hours alert gating + catch-up.
//
// A Device with `watchInterface` tracks a RouterOS interface's `running` flag
// (worker writes its status). Its ALERTS fire only inside an alert window —
// per-device `watchAlertWindow` JSON override, else the global
// Setting.uplinkAlert* defaults. Status itself updates 24/7; the window only
// gates notifications.
//
// Catch-up: a device that went down outside the window and is still down when
// the window opens gets one alert at window start. A per-window-instance Redis
// flag (`noc:uplink:alerted:<device>:<instanceStart>`) makes that fire exactly
// once — whether the first alert came from the transition or the catch-up.
// =============================================================================

import type { Device, PrismaClient, Setting } from '@prisma/client';
import type { Logger } from 'pino';
import {
  alertWindowInstanceStart,
  withinAlertWindow,
  type AlertWindow,
} from '@noc/shared';
import type { Redis } from './redis';
import { maybeNotifyTelegram, maybeNotifyWhatsApp } from './notify';

export interface UplinkLike {
  watchInterface: string | null;
  /** TCP-probe devices share the same work-hours alert window. */
  watchPort?: number | null;
  /** NAT-traffic-watch devices likewise. */
  watchNatDstPort?: string | null;
  /** Prisma JsonValue — an AlertWindow-shaped object or null. */
  watchAlertWindow: unknown;
}

/** Effective window for an uplink device: own override wins, else global. */
export function resolveUplinkWindow(d: UplinkLike, s: Setting): AlertWindow {
  const o = d.watchAlertWindow as AlertWindow | null;
  if (
    o &&
    typeof o === 'object' &&
    Number.isInteger(o.startMin) &&
    Number.isInteger(o.endMin) &&
    Array.isArray(o.days) &&
    o.days.length > 0
  ) {
    return { startMin: o.startMin, endMin: o.endMin, days: o.days };
  }
  return {
    startMin: s.uplinkAlertStartMin,
    endMin: s.uplinkAlertEndMin,
    days: s.uplinkAlertDays,
  };
}

// Flag TTL: comfortably longer than any possible window instance (<24h).
const FLAG_TTL_SEC = 20 * 3600;

/** "A down alert already went out for this window instance" — null when `at`
 *  is outside the window (no instance → nothing to mark). */
export function uplinkAlertedKey(deviceId: string, at: Date, w: AlertWindow): string | null {
  const start = alertWindowInstanceStart(w, at);
  return start === null ? null : `noc:uplink:alerted:${deviceId}:${start}`;
}

export async function markUplinkAlerted(
  redis: Redis,
  deviceId: string,
  at: Date,
  w: AlertWindow,
): Promise<void> {
  const key = uplinkAlertedKey(deviceId, at, w);
  if (key) await redis.set(key, '1', 'EX', FLAG_TTL_SEC);
}

/**
 * Work-hours catch-up, called once per router poll after statuses are applied:
 * any uplink device that is STILL down while its window is now open — and has
 * not already alerted for this window instance — gets the alert that was
 * suppressed overnight. The notifiers re-run the full gate set (critical,
 * maintenance, silence, site mode, cooldown), so catch-up can never bypass an
 * operator mute.
 */
export async function uplinkWindowCatchUp(
  deps: { prisma: PrismaClient; redisPub: Redis; logger: Logger },
  uplinks: Device[],
  settings: Setting,
): Promise<void> {
  const now = new Date();
  for (const d of uplinks) {
    if (d.status !== 'down' || !(d.watchInterface || d.watchPort || d.watchNatDstPort)) continue;
    const w = resolveUplinkWindow(d, settings);
    const key = uplinkAlertedKey(d.id, now, w);
    if (!key) continue; // window still closed
    if (await deps.redisPub.get(key)) continue; // already alerted this window
    deps.logger.info(
      { deviceId: d.id, iface: d.watchInterface },
      'uplink catch-up alert at window open',
    );
    // Synthesise a down transition; both notifiers re-check the window and, on
    // success, mark the instance flag themselves.
    await maybeNotifyTelegram(deps, d, 'up', 'down');
    await maybeNotifyWhatsApp(deps, d, 'up', 'down');
  }
}

export { withinAlertWindow };
