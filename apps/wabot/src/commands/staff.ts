// =============================================================================
// Staff commands — for verified AppUsers with role viewer/operator/super_admin.
// Site scoping reuses the shared RBAC helpers (siteScopeFor / canAccessSite),
// so a WhatsApp command can never see outside the user's assigned sites.
// =============================================================================

import type { AppUser } from '@prisma/client';
import {
  REDIS_KEYS,
  canAccessSite,
  siteScopeFor,
  type Role,
  type ScopedUser,
} from '@noc/shared';
import {
  clientForRouter,
  computeSiteSummary,
  publishSiteEvent,
  publishSiteSummary,
  readWaSession,
  toDeviceDto,
} from '@noc/server';
import type { BotCtx } from '../tickets';
import { DIV, card, cmd } from '../fmt';

export const scoped = (u: AppUser): ScopedUser => ({
  role: u.role as Role,
  scopeSiteIds: (u.scopeSiteIds as string[]) ?? [],
});

const siteWhere = (u: ScopedUser) => {
  const scope = siteScopeFor(u);
  return scope ? { id: { in: scope } } : {};
};

/**
 * Pending numbered pick — a fuzzy lookup that matches several devices stashes
 * the candidates per phone for 120 s; the next bare digit reply selects one
 * instead of forcing the operator to retype a longer name.
 */
type PickAction = 'ack' | 'unack' | 'maint-on' | 'maint-off' | 'silent' | 'unsilent' | 'cek';
interface WaPick {
  action: PickAction;
  deviceIds: string[];
  minutes?: number;
}

const PICK_TTL_SEC = 120;

async function savePick(ctx: BotCtx, phone: string, p: WaPick): Promise<void> {
  await ctx.redis
    .set(REDIS_KEYS.waPick(phone), JSON.stringify(p), 'EX', PICK_TTL_SEC)
    .catch(() => undefined);
}

/**
 * Resolve exactly one device by fuzzy name OR IP inside the caller's site
 * scope. Replies and returns null on zero/ambiguous hits — ambiguous replies
 * offer a numbered pick when `opts.pick` describes the pending action.
 */
async function pickDevice(
  ctx: BotCtx,
  phone: string,
  u: ScopedUser,
  arg: string,
  opts: {
    extraWhere?: { status?: string };
    pick?: { action: PickAction; minutes?: number };
  } = {},
) {
  const scope = siteScopeFor(u);
  const hits = await ctx.prisma.device.findMany({
    where: {
      OR: [
        { name: { contains: arg, mode: 'insensitive' } },
        { ipAddress: { contains: arg } },
      ],
      ...(scope ? { siteId: { in: scope } } : {}),
      ...opts.extraWhere,
    },
    include: { site: { select: { name: true } } },
    take: 10,
  });
  if (hits.length === 0) {
    await ctx.reply(phone, card('❓ *Tidak ditemukan*', `Perangkat "${arg}" tidak ada dalam scope Anda.`));
    return null;
  }
  if (hits.length > 1) {
    const top = hits.slice(0, 9);
    if (opts.pick) {
      await savePick(ctx, phone, {
        action: opts.pick.action,
        minutes: opts.pick.minutes,
        deviceIds: top.map((d) => d.id),
      });
    }
    await ctx.reply(
      phone,
      card(
        '🔍 *Terlalu umum*',
        `Ada *${hits.length}* perangkat cocok:\n${top.map((d, i) => `*${i + 1}.* ${d.name} — ${d.site.name}`).join('\n')}`,
        opts.pick ? 'Balas nomornya untuk memilih — atau perjelas nama' : 'Perjelas namanya',
      ),
    );
    return null;
  }
  return hits[0];
}

const ago = (iso: string | null): string => {
  if (!iso) return '?';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} mnt`;
  return `${Math.floor(m / 60)}j ${m % 60}m`;
};

/** `sites` / `status` — one-line health summary per accessible site. */
export async function staffSites(ctx: BotCtx, phone: string, u: ScopedUser) {
  const sites = await ctx.prisma.site.findMany({
    where: siteWhere(u),
    orderBy: { name: 'asc' },
  });
  if (sites.length === 0) {
    await ctx.reply(phone, card('📡 *Ringkasan Site*', 'Tidak ada site dalam scope akun Anda.'));
    return;
  }
  const lines: string[] = [];
  for (const s of sites) {
    const sum = await computeSiteSummary(ctx.prisma, s.id);
    const flag = sum.down > 0 ? '🔴' : sum.unknown > 0 ? '🟡' : '🟢';
    lines.push(
      `${flag} *${s.name}* — ${sum.up}/${sum.total} up (${sum.availabilityPct}%)` +
        (sum.down ? ` · ${sum.down} DOWN` : ''),
    );
  }
  await ctx.reply(phone, card('📡 *Ringkasan Site*', lines, 'DOWN <site> · TIKET · LAPORAN · ACK <nama> · PING <ip>'));
}

/** `down [site]` — devices currently down, optionally narrowed to one site. */
export async function staffDown(ctx: BotCtx, phone: string, u: ScopedUser, arg: string) {
  const scope = siteScopeFor(u);
  let siteIds = scope;
  if (arg) {
    const sites = await ctx.prisma.site.findMany({ where: siteWhere(u) });
    const hit = sites.find((s) => s.name.toLowerCase().includes(arg.toLowerCase()));
    if (!hit) {
      await ctx.reply(phone, card('❓ *Site tidak ditemukan*', `"${arg}" tidak ada dalam scope Anda.`));
      return;
    }
    siteIds = [hit.id];
  }
  const devices = await ctx.prisma.device.findMany({
    where: {
      status: 'down',
      // `!= 'maintenance'` excludes NULL rows in SQL — most devices have no
      // override, so the OR is required or DOWN always reports empty.
      OR: [{ manualOverride: null }, { manualOverride: { not: 'maintenance' } }],
      ...(siteIds ? { siteId: { in: siteIds } } : {}),
    },
    include: { site: { select: { name: true } } },
    orderBy: { statusSince: 'asc' },
    take: 25,
  });
  if (devices.length === 0) {
    await ctx.reply(phone, card('🟢 *Semua aman*', 'Tidak ada perangkat DOWN dalam scope Anda.'));
    return;
  }
  const lines = devices.map(
    (d) =>
      `· *${d.name}* (${d.ipAddress})\n   ${d.site.name} · down ${ago(
        d.statusSince?.toISOString() ?? null,
      )}${d.ackBy ? ` · _ack:${d.ackBy}_` : ''}`,
  );
  await ctx.reply(
    phone,
    card(`🔴 *Perangkat DOWN*` + (devices.length === 25 ? ' (25 terlama)' : ''), lines, 'ACK <nama> untuk tandai dikerjakan'),
  );
}

type DeviceDetail = {
  id: string;
  name: string;
  ipAddress: string | null;
  status: string;
  statusSince: Date | null;
  manualOverride: string | null;
  ackBy: string | null;
  silencedUntil: Date | null;
  site: { name: string };
  router: { name: string };
};

/** One-device detail card — shared by CEK and numbered-pick resolution. */
async function replyDeviceDetail(ctx: BotCtx, phone: string, d: DeviceDetail) {
  const icon = d.manualOverride === 'maintenance' ? '🛠️' : d.status === 'up' ? '🟢' : d.status === 'down' ? '🔴' : '🟡';
  const status =
    d.manualOverride === 'maintenance' ? 'MAINTENANCE' : d.status.toUpperCase();
  await ctx.reply(
    phone,
    card(`${icon} *${d.name}*`, [
      `Status   : *${status}*`,
      `IP       : ${d.ipAddress ?? '-'}`,
      `Site     : ${d.site.name} · router ${d.router.name}`,
      `Sejak    : ${ago(d.statusSince?.toISOString() ?? null)}`,
      d.ackBy ? `Ack      : ${d.ackBy}` : null,
      d.silencedUntil && d.silencedUntil > new Date()
        ? `Silent   : s/d ${d.silencedUntil.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}`
        : null,
    ].filter(Boolean) as string[], d.ipAddress ? `PING ${d.ipAddress} untuk tes langsung` : undefined),
  );
}

/** `cek <nama|ip>` — ask the current status of one device (down OR unknown OR up). */
export async function staffCek(
  ctx: BotCtx,
  phone: string,
  u: ScopedUser,
  arg: string,
  opts: { pickable?: boolean } = {},
) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*CEK* <nama-atau-ip>', 'Contoh: CEK QC 3 · CEK 192.168.101.5'));
    return;
  }
  const scope = siteScopeFor(u);
  const hits = await ctx.prisma.device.findMany({
    where: {
      OR: [
        { name: { contains: arg, mode: 'insensitive' } },
        { ipAddress: { contains: arg } },
      ],
      ...(scope ? { siteId: { in: scope } } : {}),
    },
    include: { site: { select: { name: true } }, router: { select: { name: true } } },
    orderBy: { name: 'asc' },
    take: 10,
  });
  if (hits.length === 0) {
    await ctx.reply(phone, card('❓ *Tidak ditemukan*', `Perangkat "${arg}" tidak ada dalam scope Anda.`));
    return;
  }
  if (hits.length > 1) {
    const top = hits.slice(0, 9);
    if (opts.pickable) {
      await savePick(ctx, phone, { action: 'cek', deviceIds: top.map((d) => d.id) });
    }
    await ctx.reply(
      phone,
      card(
        '🔍 *Terlalu umum*',
        `Ada *${hits.length}* perangkat cocok:\n${top.map((d, i) => `*${i + 1}.* ${d.name} — ${d.site.name}`).join('\n')}`,
        opts.pickable ? 'Balas nomornya untuk memilih — atau perjelas nama' : 'Perjelas namanya',
      ),
    );
    return;
  }
  await replyDeviceDetail(ctx, phone, hits[0]!);
}

type Picked = { id: string; name: string; siteId: string };

async function applyAck(ctx: BotCtx, phone: string, user: AppUser, d: Picked) {
  const actor = user.name || user.email;
  await ctx.prisma.device.update({
    where: { id: d.id },
    data: { ackBy: actor, ackAt: new Date() },
  });
  await ctx.prisma.auditLog
    .create({
      data: {
        userId: user.id,
        action: 'ack',
        entity: 'incident',
        entityId: d.id,
        after: { ackBy: actor, via: 'whatsapp' },
      },
    })
    .catch(() => undefined);
  await ctx.reply(phone, card('✅ *Ditandai*', `*${d.name}* sedang dikerjakan oleh ${actor}.`));
}

/** `ack <nama>` — mark the matching down device as being handled. */
export async function staffAck(ctx: BotCtx, phone: string, user: AppUser, arg: string) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*ACK* <nama-perangkat>', 'Contoh: ACK QC 3'));
    return;
  }
  const d = await pickDevice(ctx, phone, scoped(user), arg, {
    extraWhere: { status: 'down' },
    pick: { action: 'ack' },
  });
  if (!d) return;
  await applyAck(ctx, phone, user, d);
}

async function applyUnack(ctx: BotCtx, phone: string, user: AppUser, d: Picked & { ackBy: string | null }) {
  if (!d.ackBy) {
    await ctx.reply(phone, card('ℹ️ *Tanpa ack*', `*${d.name}* memang belum di-ack siapa pun.`));
    return;
  }
  await ctx.prisma.device.update({ where: { id: d.id }, data: { ackBy: null, ackAt: null } });
  await ctx.prisma.auditLog
    .create({
      data: {
        userId: user.id,
        action: 'unack',
        entity: 'incident',
        entityId: d.id,
        after: { ackBy: null, prevAckBy: d.ackBy, via: 'whatsapp' },
      },
    })
    .catch(() => undefined);
  await ctx.reply(phone, card('↩️ *Ack dilepas*', `*${d.name}* tidak lagi ditandai dikerjakan.`));
}

/** `unack <nama>` — release the ack marker (device stays down, just unclaimed). */
export async function staffUnack(ctx: BotCtx, phone: string, user: AppUser, arg: string) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*UNACK* <nama-perangkat>', 'Contoh: UNACK QC 3'));
    return;
  }
  const d = await pickDevice(ctx, phone, scoped(user), arg, { pick: { action: 'unack' } });
  if (!d) return;
  await applyUnack(ctx, phone, user, d);
}

async function applyMaint(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  d: Picked & { manualOverride: string | null },
  on: boolean,
) {
  if ((d.manualOverride === 'maintenance') === on) {
    await ctx.reply(phone, card('ℹ️ *Tidak berubah*', `*${d.name}* sudah ${on ? 'maintenance' : 'aktif'}.`));
    return;
  }
  const u = await ctx.prisma.device.update({
    where: { id: d.id },
    data: { manualOverride: on ? 'maintenance' : null },
  });
  const dto = toDeviceDto(u);
  await publishSiteEvent(ctx.redis, u.siteId, {
    type: 'device.updated',
    siteId: u.siteId,
    deviceId: u.id,
    device: dto,
  }).catch(() => undefined);
  // Maintenance wins the displayed status — recompute site counts like the web does.
  await publishSiteSummary({ prisma: ctx.prisma, redisPub: ctx.redis }, u.siteId).catch(() => undefined);
  const actor = user.name || user.email;
  await ctx.prisma.auditLog
    .create({
      data: {
        userId: user.id,
        action: on ? 'maintenance' : 'unmaintenance',
        entity: 'device',
        entityId: d.id,
        after: { manualOverride: u.manualOverride, via: 'whatsapp', actor },
      },
    })
    .catch(() => undefined);
  await ctx.reply(
    phone,
    card(
      on ? '🛠️ *Mode Maintenance*' : '🟢 *Kembali Aktif*',
      `*${d.name}* ${on ? 'ditandai maintenance — alert disenyapkan.' : 'kembali dipantau normal.'}`,
      on ? 'AKTIF <nama> untuk mengakhiri' : undefined,
    ),
  );
}

/** Fuzzy-match one site inside the caller's scope — replies on zero/ambiguous. */
async function pickSite(
  ctx: BotCtx,
  phone: string,
  u: ScopedUser,
  arg: string,
): Promise<{ id: string; name: string } | null> {
  const sites = await ctx.prisma.site.findMany({
    where: siteWhere(u),
    orderBy: { name: 'asc' },
  });
  const hits = sites.filter((s) => s.name.toLowerCase().includes(arg.toLowerCase()));
  if (hits.length === 0) {
    await ctx.reply(phone, card('❓ *Site tidak ditemukan*', `"${arg}" tidak ada dalam scope Anda.`));
    return null;
  }
  if (hits.length > 1) {
    await ctx.reply(
      phone,
      card('🔍 *Terlalu umum*', `Ada *${hits.length}* site cocok:\n${hits.map((s) => `· ${s.name}`).join('\n')}`, 'Perjelas namanya'),
    );
    return null;
  }
  return hits[0]!;
}

/**
 * `maint|aktif site <nama>` — maintenance override for EVERY device on the
 * site (planned work/outage). One updateMany + one summary publish — no
 * per-device event fan-out so a 37-device site doesn't flood the WS room.
 */
async function siteMaint(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  siteArg: string,
  on: boolean,
) {
  const site = await pickSite(ctx, phone, scoped(user), siteArg);
  if (!site) return;
  const r = await ctx.prisma.device.updateMany({
    where: {
      siteId: site.id,
      ...(on
        ? { OR: [{ manualOverride: null }, { manualOverride: { not: 'maintenance' } }] }
        : { manualOverride: 'maintenance' }),
    },
    data: { manualOverride: on ? 'maintenance' : null },
  });
  await publishSiteSummary({ prisma: ctx.prisma, redisPub: ctx.redis }, site.id).catch(() => undefined);
  const actor = user.name || user.email;
  await ctx.prisma.auditLog
    .create({
      data: {
        userId: user.id,
        action: on ? 'site-maintenance' : 'site-unmaintenance',
        entity: 'site',
        entityId: site.id,
        after: { devices: r.count, via: 'whatsapp', actor },
      },
    })
    .catch(() => undefined);
  await ctx.reply(
    phone,
    card(
      on ? '🛠️ *Site Maintenance*' : '🟢 *Site Aktif Lagi*',
      `*${site.name}* — *${r.count}* perangkat ${on ? 'ditandai maintenance' : 'kembali dipantau normal'}.`,
      on ? `AKTIF SITE ${site.name} untuk mengakhiri` : undefined,
    ),
  );
}

/**
 * `maint <nama>` (on=true) / `aktif <nama>` (on=false) — toggle the
 * maintenance override, same field the web PATCH writes. `SITE` prefix does
 * the whole site. Mirrors the web route: update → event → summary → audit.
 */
export async function staffMaint(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  arg: string,
  on: boolean,
) {
  if (!arg) {
    await ctx.reply(
      phone,
      card('ℹ️ *Cara pakai*', on ? '*MAINT* <nama|SITE nama>' : '*AKTIF* <nama|SITE nama>', 'Contoh: MAINT QC 3 · MAINT SITE Pabrik 2'),
    );
    return;
  }
  const siteM = /^site\s+(.+)$/i.exec(arg.trim());
  if (siteM) {
    await siteMaint(ctx, phone, user, siteM[1]!.trim(), on);
    return;
  }
  const d = await pickDevice(ctx, phone, scoped(user), arg, {
    pick: { action: on ? 'maint-on' : 'maint-off' },
  });
  if (!d) return;
  await applyMaint(ctx, phone, user, d, on);
}

async function applySilent(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  d: Picked,
  on: boolean,
  minutes: number,
) {
  const silencedUntil = on ? new Date(Date.now() + minutes * 60_000) : null;
  await ctx.prisma.device.update({ where: { id: d.id }, data: { silencedUntil } });
  await ctx.prisma.auditLog
    .create({
      data: {
        userId: user.id,
        action: on ? 'silence' : 'unsilence',
        entity: 'incident',
        entityId: d.id,
        after: { silencedUntil, via: 'whatsapp' },
      },
    })
    .catch(() => undefined);
  const until = silencedUntil?.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  });
  await ctx.reply(
    phone,
    card(
      on ? '🔕 *Alert Dibungkam*' : '🔔 *Alert Aktif Lagi*',
      on ? `*${d.name}* disenyapkan *${minutes}* menit (s/d ${until} WIB).` : `*${d.name}* berbunyi lagi.`,
      on ? 'BUNYI <nama> untuk menyalakan kembali' : undefined,
    ),
  );
}

/** `silent|bunyi site <nama> [menit]` — silence the whole site's alerts. */
async function siteSilent(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  siteArg: string,
  on: boolean,
  minutes: number,
) {
  const site = await pickSite(ctx, phone, scoped(user), siteArg);
  if (!site) return;
  const silencedUntil = on ? new Date(Date.now() + minutes * 60_000) : null;
  const r = await ctx.prisma.device.updateMany({
    where: { siteId: site.id },
    data: { silencedUntil },
  });
  const actor = user.name || user.email;
  await ctx.prisma.auditLog
    .create({
      data: {
        userId: user.id,
        action: on ? 'site-silence' : 'site-unsilence',
        entity: 'site',
        entityId: site.id,
        after: { devices: r.count, silencedUntil, via: 'whatsapp', actor },
      },
    })
    .catch(() => undefined);
  const until = silencedUntil?.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  });
  await ctx.reply(
    phone,
    card(
      on ? '🔕 *Site Dibungkam*' : '🔔 *Site Berbunyi Lagi*',
      on
        ? `*${r.count}* perangkat di *${site.name}* disenyapkan *${minutes}* menit (s/d ${until} WIB).`
        : `*${r.count}* perangkat di *${site.name}* berbunyi lagi.`,
      on ? `BUNYI SITE ${site.name} untuk menyalakan kembali` : undefined,
    ),
  );
}

/**
 * `silent <nama> [menit]` (on=true) / `bunyi <nama>` (on=false) — suppress
 * alerts for N minutes like POST /incidents/:id/silence. `SITE` prefix does
 * the whole site (0/bunyi = unsilence).
 */
export async function staffSilent(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  arg: string,
  on: boolean,
) {
  if (!arg) {
    await ctx.reply(
      phone,
      card('ℹ️ *Cara pakai*', '*SILENT* <nama|SITE nama> [menit] · *BUNYI* <nama|SITE nama>', 'Contoh: SILENT QC 3 120 · SILENT SITE Pabrik 2 240'),
    );
    return;
  }
  const u = scoped(user);
  const siteM = /^site\s+(.+)$/i.exec(arg.trim());
  if (siteM) {
    // Same name-vs-duration rule as devices: a trailing number only counts as
    // minutes when the rest still resolves to a real site.
    let siteArg = siteM[1]!.trim();
    let siteMinutes = 60;
    if (on) {
      const m = /^(.*?)[ \t]+(\d{1,4})$/.exec(siteArg);
      if (m) {
        const sites = await ctx.prisma.site.findMany({ where: siteWhere(u) });
        const full = sites.some((s) => s.name.toLowerCase().includes(siteArg.toLowerCase()));
        if (!full && m[1]!.trim()) {
          siteArg = m[1]!.trim();
          siteMinutes = Math.min(Number(m[2]), 24 * 60);
        }
      }
    }
    await siteSilent(ctx, phone, user, siteArg, on, siteMinutes);
    return;
  }
  let minutes = 60;
  let name = arg;
  if (on) {
    // A trailing number is only a duration when the full string isn't itself a
    // device name — "QC 3" is a name, "QC 3 120" is name + minutes.
    const m = /^(.*?)[ \t]+(\d{1,4})$/.exec(arg);
    if (m) {
      const scope = siteScopeFor(u);
      const fullMatch = await ctx.prisma.device.count({
        where: {
          name: { contains: arg, mode: 'insensitive' },
          ...(scope ? { siteId: { in: scope } } : {}),
        },
      });
      if (fullMatch === 0) {
        name = m[1]!.trim();
        minutes = Math.min(Number(m[2]), 24 * 60);
      }
    }
  }
  const d = await pickDevice(ctx, phone, u, name, {
    pick: { action: on ? 'silent' : 'unsilent', minutes },
  });
  if (!d) return;
  await applySilent(ctx, phone, user, d, on, minutes);
}

/**
 * `botstatus` — WA session + outbox health straight from chat, so NOC can
 * diagnose "alert tidak sampai" tanpa SSH/web (whatsapp:manage = super_admin).
 */
export async function staffBotStatus(ctx: BotCtx, phone: string) {
  const s = await readWaSession(ctx.redis).catch(() => null);
  const since = new Date(Date.now() - 24 * 3600_000);
  const [depth, sent24h, fail24h, dead24h, convs] = await Promise.all([
    ctx.redis.llen(REDIS_KEYS.waOutbox).catch(() => -1),
    ctx.prisma.waMessage.count({ where: { createdAt: { gte: since }, status: 'sent' } }),
    ctx.prisma.waMessage.count({ where: { createdAt: { gte: since }, status: 'failed' } }),
    ctx.prisma.waMessage.count({ where: { createdAt: { gte: since }, status: 'dead' } }),
    ctx.redis.keys(REDIS_KEYS.waConv('*')).catch(() => [] as string[]),
  ]);
  const icon =
    ({ connected: '🟢', qr: '🟡', connecting: '🟡', disabled: '⚫', offline: '🔴' } as Record<string, string>)[
      s?.status ?? 'offline'
    ] ?? '🔴';
  await ctx.reply(
    phone,
    card(
      `${icon} *Status Bot WhatsApp*`,
      [
        `Sesi        : *${s?.status ?? 'tidak ada'}*${s?.phone ? ` (${s.phone})` : ''}`,
        s?.name ? `Akun        : ${s.name}` : null,
        s?.error ? `Error       : ${s.error}` : null,
        `Update      : ${ago(s?.updatedAt ?? null)}`,
        DIV,
        `Antre outbox : ${depth >= 0 ? `*${depth}*` : '?'}`,
        `Terkirim 24j : *${sent24h}* · gagal ${fail24h} · dead ${dead24h}`,
        `Wizard aktif : ${convs.length}`,
      ].filter(Boolean) as string[],
      'Reconnect/logout: Admin → WhatsApp',
    ),
  );
}

/** `ping <ip|nama>` — ping from the router that owns the device (same as UI). */
export async function staffPing(ctx: BotCtx, phone: string, user: AppUser, arg: string) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*PING* <ip-atau-nama-perangkat>', 'Contoh: PING 192.168.101.174 · PING QC 3'));
    return;
  }
  const u = scoped(user);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(arg);
  const d = isIp
    ? await ctx.prisma.device.findFirst({ where: { ipAddress: arg }, include: { site: true, router: true } })
    : await ctx.prisma.device.findFirst({ where: { name: { contains: arg, mode: 'insensitive' } }, include: { site: true, router: true } });
  if (!d || !canAccessSite(u, d.siteId)) {
    await ctx.reply(phone, card('❓ *Tidak dikenal*', `"${arg}" tidak terdaftar di NOC / di luar scope Anda.`));
    return;
  }
  const ip = d.ipAddress;
  if (!ip) {
    await ctx.reply(phone, card('ℹ️ *Tanpa IP*', `Perangkat *${d.name}* tidak punya alamat IP tercatat.`));
    return;
  }
  const c = clientForRouter(d.router);
  try {
    const r = await c.pingHost(ip);
    const verdict = r.lossPct === 100 ? '🔴 100% loss' : r.lossPct! > 0 ? '🟡 loss sebagian' : '🟢 reachable';
    await ctx.reply(
      phone,
      card(
        `📡 *PING ${ip}*`,
        [
          `Via router *${d.router.name}*`,
          `Kirim ${r.sent} · terima ${r.received} · loss ${r.lossPct}%  →  ${verdict}`,
          r.avgMs != null ? `min/avg/max: *${r.minMs}/${r.avgMs}/${r.maxMs} ms*` : null,
        ].filter(Boolean) as string[],
      ),
    );
  } catch (err) {
    ctx.logger.warn({ err }, 'wa ping failed');
    await ctx.reply(phone, card('⚠️ *Router offline*', `Router ${d.router.name} tidak bisa dihubungi.`));
  } finally {
    await c.close();
  }
}

/** `tiket [kode]` — open tickets in scope, or one ticket's full detail. */
export async function staffTickets(ctx: BotCtx, phone: string, u: ScopedUser, arg: string) {
  const scope = siteScopeFor(u);
  if (arg) {
    const t = await ctx.prisma.ticket.findFirst({
      where: {
        id: { startsWith: arg.toLowerCase() },
        ...(scope ? { siteId: { in: scope } } : {}),
      },
      include: {
        site: { select: { name: true } },
        member: { select: { name: true, hotspotUsername: true } },
      },
    });
    if (!t) {
      await ctx.reply(phone, card('❓ *Tiket tidak ada*', `Tiket *#${arg.toUpperCase()}* tidak ditemukan dalam scope Anda.`));
      return;
    }
    const label = { open: '🟡 OPEN', ack: '🔧 DIPROSES', resolved: '✅ SELESAI' } as const;
    const when = t.createdAt.toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    await ctx.reply(
      phone,
      card(`🎫 *TIKET #${t.id.slice(0, 6).toUpperCase()}*`, [
        `Status   : ${label[t.status as keyof typeof label] ?? t.status}`,
        `Site     : ${t.site.name}`,
        `Pelapor  : ${t.reporterName ?? 'Anonim'}${t.reporterDept ? ` · ${t.reporterDept}` : ''}`,
        `Kontak   : ${t.reporterPhone ?? 'via web'}`,
        t.member?.hotspotUsername ? `Akun     : ${t.member.hotspotUsername}` : null,
        `Kategori : ${t.category}`,
        `Waktu    : ${when} WIB`,
        t.handledBy ? `Teknisi  : ${t.handledBy}` : null,
        t.resolvedAt ? `Selesai  : ${t.resolvedAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} WIB` : null,
        DIV,
        `"${t.message}"`,
      ].filter(Boolean) as string[],
      t.status !== 'resolved' ? `Balas PROSES/SELESAI ${t.id.slice(0, 6).toUpperCase()}` : undefined),
    );
    return;
  }
  const rows = await ctx.prisma.ticket.findMany({
    where: {
      status: { in: ['open', 'ack'] },
      ...(scope ? { siteId: { in: scope } } : {}),
    },
    include: { site: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
    take: 15,
  });
  if (rows.length === 0) {
    await ctx.reply(phone, card('🟢 *Tiket bersih*', 'Tidak ada tiket terbuka dalam scope Anda.'));
    return;
  }
  await ctx.reply(
    phone,
    card(
      `🎫 *Tiket Terbuka* (${rows.length})`,
      rows.map(
        (t) =>
          `*#${t.id.slice(0, 6).toUpperCase()}* ${t.status === 'ack' ? '🔧' : '🟡'} ${t.site.name}\n   ${
            t.reporterName ?? 'Anonim'
          }${t.reporterDept ? ` · ${t.reporterDept}` : ''} · ${t.reporterPhone ?? 'web'}\n   "${
            t.message.slice(0, 80)
          }"`,
      ),
      'Balas PROSES <kode> · SELESAI <kode>',
    ),
  );
}

/** `laporan [site]` — 24h digest: site health + insiden + tiket in scope. */
export async function staffReport(ctx: BotCtx, phone: string, u: ScopedUser, arg: string) {
  const scope = siteScopeFor(u);
  let sites = await ctx.prisma.site.findMany({
    where: siteWhere(u),
    orderBy: { name: 'asc' },
  });
  if (arg) {
    sites = sites.filter((s) => s.name.toLowerCase().includes(arg.toLowerCase()));
    if (sites.length === 0) {
      await ctx.reply(phone, card('❓ *Site tidak ada*', `Site "${arg}" tidak ditemukan dalam scope Anda.`));
      return;
    }
  }
  const scopeIds = sites.map((s) => s.id);
  const since = new Date(Date.now() - 24 * 3600_000);
  const [downEvents, openTickets, resolvedToday] = await Promise.all([
    ctx.prisma.statusEvent.count({
      where: {
        occurredAt: { gte: since },
        newStatus: 'down',
        device: { siteId: { in: scopeIds } },
      },
    }),
    ctx.prisma.ticket.count({
      where: { status: { in: ['open', 'ack'] }, siteId: { in: scopeIds } },
    }),
    ctx.prisma.ticket.count({
      where: { status: 'resolved', resolvedAt: { gte: since }, siteId: { in: scopeIds } },
    }),
  ]);
  const lines: string[] = [];
  for (const s of sites) {
    const sum = await computeSiteSummary(ctx.prisma, s.id);
    const flag = sum.down > 0 ? '🔴' : sum.unknown > 0 ? '🟡' : '🟢';
    lines.push(
      `${flag} *${s.name}* — ${sum.up}/${sum.total} up · availability ${sum.availabilityPct}%`,
    );
  }
  await ctx.reply(
    phone,
    card(`📊 *Laporan 24 Jam*${arg ? ` — ${sites[0]!.name}` : ''}`, [
      ...lines,
      DIV,
      `� Insiden down 24 jam : *${downEvents}*`,
      `🎫 Tiket terbuka       : *${openTickets}*`,
      `✅ Tiket selesai 24 jam : *${resolvedToday}*`,
    ]),
  );
}

/**
 * A pending numbered pick resolves before any new command parses — "2" after
 * "ada 3 perangkat cocok" runs the stashed action on candidate #2. Private
 * staff only (write ops need the AppUser for audit anyway).
 * Returns true when `text` was consumed as a pick reply.
 */
export async function staffPickResolve(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  text: string,
): Promise<boolean> {
  if (!/^\d{1,2}$/.test(text.trim())) return false;
  const key = REDIS_KEYS.waPick(phone);
  const raw = await ctx.redis.get(key).catch(() => null);
  if (!raw) return false;
  let p: WaPick | null = null;
  try {
    p = JSON.parse(raw) as WaPick;
  } catch {
    /* fall through */
  }
  if (!p || !Array.isArray(p.deviceIds) || p.deviceIds.length === 0) {
    await ctx.redis.del(key).catch(() => undefined);
    return false;
  }
  const n = Number(text.trim());
  if (n < 1 || n > p.deviceIds.length) {
    await ctx.reply(
      phone,
      card('❓ *Pilihan tidak ada*', `Balas dengan nomor *1–${p.deviceIds.length}* — atau abaikan.`),
    );
    return true;
  }
  await ctx.redis.del(key).catch(() => undefined);
  const d = await ctx.prisma.device.findUnique({
    where: { id: p.deviceIds[n - 1]! },
    include: { site: { select: { name: true } }, router: { select: { name: true } } },
  });
  if (!d) {
    await ctx.reply(phone, card('❓ *Sudah tidak ada*', 'Perangkatnya sudah dihapus dari NOC.'));
    return true;
  }
  if (!canAccessSite(scoped(user), d.siteId)) {
    await ctx.reply(phone, card('⛔ *Di luar scope*', `*${d.name}* bukan site Anda.`));
    return true;
  }
  switch (p.action) {
    case 'ack':
      await applyAck(ctx, phone, user, d);
      return true;
    case 'unack':
      await applyUnack(ctx, phone, user, d);
      return true;
    case 'maint-on':
      await applyMaint(ctx, phone, user, d, true);
      return true;
    case 'maint-off':
      await applyMaint(ctx, phone, user, d, false);
      return true;
    case 'silent':
      await applySilent(ctx, phone, user, d, true, p.minutes ?? 60);
      return true;
    case 'unsilent':
      await applySilent(ctx, phone, user, d, false, 0);
      return true;
    case 'cek':
      await replyDeviceDetail(ctx, phone, d);
      return true;
    default:
      return false;
  }
}

/**
 * Read-only staff commands shared by every trusted surface — verified staff
 * in private chat, WaRecipient numbers (pseudo-scope) and group chats. Write
 * commands (ack/silent/maint) stay private-staff-only. `opts.picks` enables
 * numbered-pick offers after ambiguous CEK (private chat only — a group's
 * shared reply target can't key a per-sender pick). Returns false when the
 * command isn't in the read set.
 */
export async function staffRead(
  ctx: BotCtx,
  to: string,
  u: ScopedUser,
  cmd: string,
  arg: string,
  opts: { picks?: boolean } = {},
): Promise<boolean> {
  switch (cmd) {
    case 'sites':
    case 'status':
      await staffSites(ctx, to, u);
      return true;
    case 'down':
      await staffDown(ctx, to, u, arg);
      return true;
    case 'cek':
      await staffCek(ctx, to, u, arg, { pickable: opts.picks === true });
      return true;
    case 'tiket':
    case 'tickets':
      await staffTickets(ctx, to, u, arg);
      return true;
    case 'laporan':
      await staffReport(ctx, to, u, arg);
      return true;
    default:
      return false;
  }
}

export const STAFF_MENU = [
  '🛠️ *Menu Staff NOC*',
  cmd('SITES', 'ringkasan semua site'),
  cmd('DOWN [site]', 'perangkat down saat ini'),
  cmd('CEK <nama|ip>', 'status satu perangkat'),
  cmd('ACK/UNACK <nama>', 'tandai/lepas insiden dikerjakan'),
  cmd('MAINT/AKTIF <nama|SITE nama>', 'maintenance perangkat/site'),
  cmd('SILENT <nama|SITE nama> [menit]', 'senyapkan alert (default 60m)'),
  cmd('BUNYI <nama|SITE nama>', 'nyalakan lagi alert'),
  cmd('PING <ip|nama>', 'ping perangkat dari router site'),
  cmd('TIKET [kode]', 'tiket terbuka / detail tiket'),
  cmd('PROSES/SELESAI <kode> [catatan]', 'kerjakan tiket'),
  cmd('LAPORAN [site]', 'digest 24 jam'),
  cmd('BOTSTATUS', 'status sesi & antrean WA (admin)'),
  cmd('KOMPLAIN <pesan>', 'buat tiket'),
  DIV,
  '_Balas nomor setelah "terlalu umum" · balas PROSES/SELESAI ke kartu tiket langsung_',
].join('\n');
