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
 * Resolve exactly one device by fuzzy name inside the caller's site scope.
 * Replies and returns null on zero/ambiguous hits — the same UX staffCek uses.
 */
async function pickDevice(
  ctx: BotCtx,
  phone: string,
  u: ScopedUser,
  arg: string,
  extraWhere: { status?: string } = {},
) {
  const scope = siteScopeFor(u);
  const hits = await ctx.prisma.device.findMany({
    where: {
      name: { contains: arg, mode: 'insensitive' },
      ...(scope ? { siteId: { in: scope } } : {}),
      ...extraWhere,
    },
    take: 10,
  });
  if (hits.length === 0) {
    await ctx.reply(phone, card('❓ *Tidak ditemukan*', `Perangkat "${arg}" tidak ada dalam scope Anda.`));
    return null;
  }
  if (hits.length > 1) {
    await ctx.reply(
      phone,
      card('🔍 *Terlalu umum*', `Ada *${hits.length}* perangkat cocok:\n${hits.map((d) => `· ${d.name}`).join('\n')}`, 'Perjelas namanya'),
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

/** `cek <nama>` — ask the current status of one device (down OR unknown OR up). */
export async function staffCek(ctx: BotCtx, phone: string, u: ScopedUser, arg: string) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*CEK* <nama-perangkat>', 'Contoh: CEK QC 3'));
    return;
  }
  const scope = siteScopeFor(u);
  const hits = await ctx.prisma.device.findMany({
    where: {
      name: { contains: arg, mode: 'insensitive' },
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
    await ctx.reply(
      phone,
      card('🔍 *Terlalu umum*', `Ada *${hits.length}* perangkat cocok:\n${hits.map((d) => `· ${d.name} — ${d.site.name}`).join('\n')}`, 'Perjelas namanya'),
    );
    return;
  }
  const d = hits[0]!;
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

/** `ack <nama>` — mark the matching down device as being handled. */
export async function staffAck(ctx: BotCtx, phone: string, user: AppUser, arg: string) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*ACK* <nama-perangkat>', 'Contoh: ACK QC 3'));
    return;
  }
  const d = await pickDevice(ctx, phone, scoped(user), arg, { status: 'down' });
  if (!d) return;
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

/** `unack <nama>` — release the ack marker (device stays down, just unclaimed). */
export async function staffUnack(ctx: BotCtx, phone: string, user: AppUser, arg: string) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*UNACK* <nama-perangkat>', 'Contoh: UNACK QC 3'));
    return;
  }
  const d = await pickDevice(ctx, phone, scoped(user), arg);
  if (!d) return;
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

/**
 * `maint <nama>` (on=true) / `aktif <nama>` (on=false) — toggle the
 * maintenance override, same field the web PATCH writes. Mirrors the web
 * route exactly: update → device.updated event → fresh site summary → audit.
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
      card('ℹ️ *Cara pakai*', on ? '*MAINT* <nama-perangkat>' : '*AKTIF* <nama-perangkat>', 'Contoh: MAINT QC 3'),
    );
    return;
  }
  const d = await pickDevice(ctx, phone, scoped(user), arg);
  if (!d) return;
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

/**
 * `silent <nama> [menit]` (on=true) / `bunyi <nama>` (on=false) — suppress
 * alerts for N minutes like POST /incidents/:id/silence (0 = unsilence).
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
      card('ℹ️ *Cara pakai*', '*SILENT* <nama> [menit] · *BUNYI* <nama>', 'Contoh: SILENT QC 3 120'),
    );
    return;
  }
  let minutes = 60;
  let name = arg;
  if (on) {
    // A trailing number is only a duration when the full string isn't itself a
    // device name — "QC 3" is a name, "QC 3 120" is name + minutes.
    const m = /^(.*?)[ \t]+(\d{1,4})$/.exec(arg);
    if (m) {
      const scope = siteScopeFor(scoped(user));
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
  const d = await pickDevice(ctx, phone, scoped(user), name);
  if (!d) return;
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
 * Read-only staff commands shared by every trusted surface — verified staff
 * in private chat, WaRecipient numbers (pseudo-scope) and group chats. Write
 * commands (ack/silent/maint) stay private-staff-only. Returns false when the
 * command isn't in the read set.
 */
export async function staffRead(
  ctx: BotCtx,
  to: string,
  u: ScopedUser,
  cmd: string,
  arg: string,
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
      await staffCek(ctx, to, u, arg);
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
  cmd('CEK <nama>', 'status satu perangkat'),
  cmd('ACK/UNACK <nama>', 'tandai/lepas insiden dikerjakan'),
  cmd('MAINT/AKTIF <nama>', 'mode maintenance on/off'),
  cmd('SILENT <nama> [menit]', 'senyapkan alert (default 60m)'),
  cmd('BUNYI <nama>', 'nyalakan lagi alert'),
  cmd('PING <ip|nama>', 'ping perangkat dari router site'),
  cmd('TIKET [kode]', 'tiket terbuka / detail tiket'),
  cmd('PROSES/SELESAI <kode>', 'kerjakan tiket'),
  cmd('LAPORAN [site]', 'digest 24 jam'),
  cmd('BOTSTATUS', 'status sesi & antrean WA (admin)'),
  cmd('KOMPLAIN <pesan>', 'buat tiket'),
].join('\n');
