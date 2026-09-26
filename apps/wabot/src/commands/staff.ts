// =============================================================================
// Staff commands — for verified AppUsers with role viewer/operator/super_admin.
// Site scoping reuses the shared RBAC helpers (siteScopeFor / canAccessSite),
// so a WhatsApp command can never see outside the user's assigned sites.
// =============================================================================

import type { AppUser } from '@prisma/client';
import { canAccessSite, siteScopeFor, type Role, type ScopedUser } from '@noc/shared';
import { clientForRouter, computeSiteSummary } from '@noc/server';
import type { BotCtx } from '../tickets';
import { DIV, card, cmd } from '../fmt';

const scoped = (u: AppUser): ScopedUser => ({
  role: u.role as Role,
  scopeSiteIds: (u.scopeSiteIds as string[]) ?? [],
});

const siteWhere = (u: ScopedUser) => {
  const scope = siteScopeFor(u);
  return scope ? { id: { in: scope } } : {};
};

const ago = (iso: string | null): string => {
  if (!iso) return '?';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} mnt`;
  return `${Math.floor(m / 60)}j ${m % 60}m`;
};

/** `sites` / `status` — one-line health summary per accessible site. */
export async function staffSites(ctx: BotCtx, phone: string, user: AppUser) {
  const sites = await ctx.prisma.site.findMany({
    where: siteWhere(scoped(user)),
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
export async function staffDown(ctx: BotCtx, phone: string, user: AppUser, arg: string) {
  const u = scoped(user);
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

/** `ack <nama>` — mark the matching down device as being handled. */
export async function staffAck(ctx: BotCtx, phone: string, user: AppUser, arg: string) {
  if (!arg) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*ACK* <nama-perangkat>', 'Contoh: ACK QC 3'));
    return;
  }
  const u = scoped(user);
  const scope = siteScopeFor(u);
  const hits = await ctx.prisma.device.findMany({
    where: {
      status: 'down',
      name: { contains: arg, mode: 'insensitive' },
      ...(scope ? { siteId: { in: scope } } : {}),
    },
    take: 10,
  });
  if (hits.length === 0) {
    await ctx.reply(phone, card('❓ *Tidak ditemukan*', `Perangkat down "${arg}" tidak ada dalam scope Anda.`));
    return;
  }
  if (hits.length > 1) {
    await ctx.reply(
      phone,
      card('🔍 *Terlalu umum*', `Ada *${hits.length}* perangkat cocok:\n${hits.map((d) => `· ${d.name}`).join('\n')}`, 'Perjelas namanya'),
    );
    return;
  }
  const d = hits[0]!;
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

/** `ping <ip>` — ping from the router that owns the device (same as the UI). */
export async function staffPing(ctx: BotCtx, phone: string, user: AppUser, ip: string) {
  if (!ip) {
    await ctx.reply(phone, card('ℹ️ *Cara pakai*', '*PING* <ip-perangkat>', 'Contoh: PING 192.168.101.174'));
    return;
  }
  const u = scoped(user);
  const d = await ctx.prisma.device.findFirst({
    where: { ipAddress: ip },
    include: { site: true, router: true },
  });
  if (!d || !canAccessSite(u, d.siteId)) {
    await ctx.reply(phone, card('❓ *IP tidak dikenal*', `IP ${ip} tidak terdaftar di NOC / di luar scope Anda.`));
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

/** `tiket` — open tickets inside the caller's scope. */
export async function staffTickets(ctx: BotCtx, phone: string, user: AppUser) {
  const scope = siteScopeFor(scoped(user));
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

/** `laporan` — compact digest: site health + open tickets in scope. */
export async function staffReport(ctx: BotCtx, phone: string, user: AppUser) {
  const u = scoped(user);
  const scope = siteScopeFor(u);
  const sites = await ctx.prisma.site.findMany({
    where: siteWhere(u),
    orderBy: { name: 'asc' },
  });
  const since = new Date(Date.now() - 24 * 3600_000);
  const [events, openTickets] = await Promise.all([
    ctx.prisma.statusEvent.count({
      where: { occurredAt: { gte: since }, ...(scope ? { siteId: { in: scope } } : {}) },
    }),
    ctx.prisma.ticket.count({
      where: { status: { in: ['open', 'ack'] }, ...(scope ? { siteId: { in: scope } } : {}) },
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
    card('📊 *Laporan 24 Jam*', [
      ...lines,
      DIV,
      `🔄 Perubahan status: *${events}*`,
      `🎫 Tiket terbuka: *${openTickets}*`,
    ]),
  );
}

export const STAFF_MENU = [
  '🛠️ *Menu Staff NOC*',
  cmd('SITES', 'ringkasan semua site'),
  cmd('DOWN [site]', 'perangkat down saat ini'),
  cmd('ACK <nama>', 'tandai insiden dikerjakan'),
  cmd('PING <ip>', 'ping perangkat dari router site'),
  cmd('TIKET', 'tiket komplain terbuka'),
  cmd('PROSES/SELESAI <kode>', 'kerjakan tiket'),
  cmd('LAPORAN', 'digest 24 jam'),
  cmd('KOMPLAIN <pesan>', 'buat tiket'),
].join('\n');
