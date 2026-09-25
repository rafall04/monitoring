// =============================================================================
// Telegram alerting. Two delivery modes (configured per Site):
//  - "server": this relay sends the message (used here). Token stays server-side.
//  - "router": the Netwatch script on the MikroTik sends it directly (see
//    mikrotik/netwatch.ts). In that mode the server relay stays silent.
// Only is_critical devices (not under maintenance) alert. Never throws into the
// status path.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { REDIS_KEYS, renderTemplate, withinAlertWindow, type AlertWindow } from '@noc/shared';
import { decryptSecret } from './crypto';
import type { Redis } from './redis';
import { getSettings } from './settings';
import { markUplinkAlerted, resolveUplinkWindow, type UplinkLike } from './uplink';
import { enqueueWaMessage } from './wa';

const TG_API = 'https://api.telegram.org';

/** Send one Telegram message. Returns true on HTTP 2xx. Never throws. */
export async function sendTelegram(botToken: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface TelegramDeps {
  prisma: PrismaClient;
  redisPub: Redis;
  logger: Logger;
}

interface NotifyDevice extends UplinkLike {
  id: string;
  name: string;
  ipAddress: string | null;
  siteId: string;
  isCritical: boolean;
  manualOverride: string | null;
  silencedUntil?: Date | null;
}

/**
 * Fired on a device status transition (from both webhook + poller via the status
 * engine). Alerts only critical, non-maintenance devices on sites set to
 * telegramMode="server". A Redis cooldown suppresses flap spam.
 */
export async function maybeNotifyTelegram(
  deps: TelegramDeps,
  device: NotifyDevice,
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  try {
    if (!device.isCritical || device.manualOverride === 'maintenance') return;
    if (device.silencedUntil && device.silencedUntil.getTime() > Date.now()) return;
    const isDown = newStatus === 'down';
    const isRecovery = newStatus === 'up' && oldStatus === 'down';
    if (!isDown && !isRecovery) return;

    const settings = await getSettings();
    // Uplink devices alert only inside their work-hours window — the status
    // itself still updates 24/7, this gate suppresses the notification only.
    const uplinkWindow: AlertWindow | null = device.watchInterface
      ? resolveUplinkWindow(device, settings)
      : null;
    if (uplinkWindow && !withinAlertWindow(uplinkWindow, new Date())) return;

    const site = await deps.prisma.site.findUnique({ where: { id: device.siteId } });
    if (!site || site.telegramMode !== 'server' || !site.telegramBotEncrypted || !site.telegramChatId)
      return;

    // Cooldown: only one alert per device+status per 90s (guards against flapping).
    const fresh = await deps.redisPub.set(`noc:tgcooldown:${device.id}:${newStatus}`, '1', 'EX', 90, 'NX');
    if (fresh !== 'OK') return;

    const template = isDown ? settings.telegramDownTemplate : settings.telegramUpTemplate;
    const text = renderTemplate(template, {
      device: device.name,
      ip: device.ipAddress,
      site: site.name,
      status: newStatus,
    });
    const ok = await sendTelegram(decryptSecret(site.telegramBotEncrypted), site.telegramChatId, text);
    if (isDown && uplinkWindow) {
      await markUplinkAlerted(deps.redisPub, device.id, new Date(), uplinkWindow);
    }
    deps.logger.info({ deviceId: device.id, newStatus, ok }, 'telegram alert sent');
  } catch (err) {
    deps.logger.warn({ err }, 'telegram notify failed');
  }
}

/**
 * WhatsApp side of the same alert (docs/whatsapp-bot-plan.md). Identical gates
 * to Telegram — critical only, no maintenance, honor silence, down + recovery —
 * then a per-site switch (whatsappMode='server') and its own flap cooldown.
 * Delivery is queued via the Redis outbox; apps/wabot performs the send, so a
 * disconnected socket delays but never drops the alert.
 */
export async function maybeNotifyWhatsApp(
  deps: TelegramDeps,
  device: NotifyDevice,
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  try {
    if (!device.isCritical || device.manualOverride === 'maintenance') return;
    if (device.silencedUntil && device.silencedUntil.getTime() > Date.now()) return;
    const isDown = newStatus === 'down';
    const isRecovery = newStatus === 'up' && oldStatus === 'down';
    if (!isDown && !isRecovery) return;

    const settings = await getSettings();
    // Same work-hours gate as Telegram for uplink devices.
    const uplinkWindow: AlertWindow | null = device.watchInterface
      ? resolveUplinkWindow(device, settings)
      : null;
    if (uplinkWindow && !withinAlertWindow(uplinkWindow, new Date())) return;

    const site = await deps.prisma.site.findUnique({
      where: { id: device.siteId },
      include: { waRecipients: { where: { isActive: true, alerts: true } } },
    });
    if (!site || site.whatsappMode !== 'server') return;

    // Unified recipients: `target` already holds the right address form —
    // phone digits for kind='number', a group JID for kind='group'.
    const targets = site.waRecipients.map((c) => c.target);
    if (targets.length === 0) return;

    // Cooldown: one alert per device+status per 90s (same anti-flap as TG).
    const fresh = await deps.redisPub.set(
      REDIS_KEYS.waCooldown(device.id, newStatus),
      '1',
      'EX',
      90,
      'NX',
    );
    if (fresh !== 'OK') return;

    const template = isDown ? settings.waDownTemplate : settings.waUpTemplate;
    const text = renderTemplate(template, {
      device: device.name,
      ip: device.ipAddress,
      site: site.name,
      status: newStatus,
    });
    for (const to of targets) {
      await enqueueWaMessage(
        { prisma: deps.prisma, redis: deps.redisPub },
        { to, text, kind: 'alert', siteId: site.id },
      );
    }
    if (isDown && uplinkWindow) {
      await markUplinkAlerted(deps.redisPub, device.id, new Date(), uplinkWindow);
    }
    deps.logger.info(
      { deviceId: device.id, newStatus, targets: targets.length },
      'whatsapp alert queued',
    );
  } catch (err) {
    deps.logger.warn({ err }, 'whatsapp notify failed');
  }
}
