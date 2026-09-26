// =============================================================================
// Member self-service commands — the WhatsApp twin of the /akun page.
// Every action is scoped to the member's OWN linked hotspot account
// (AppUser.hotspotRouterId + hotspotUsername), exactly like me-hotspot.ts.
// =============================================================================

import type { AppUser } from '@prisma/client';
import {
  clientForRouter,
  env,
  getMemberStatus,
  kickMemberSessions,
} from '@noc/server';
import type { MikrotikClient } from '@noc/server';
import type { BotCtx } from '../tickets';
import { DIV, card, cmd } from '../fmt';

function fmtBytes(b: string | null | undefined): string {
  const n = Number(b ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtQuota(used: string | null, limit: string | null): string {
  if (!limit || Number(limit) <= 0) return `${fmtBytes(used)} (tanpa limit)`;
  return `${fmtBytes(used)} / ${fmtBytes(limit)}`;
}

/** Open a client on the member's linked router, or null if unlinked. */
async function withMemberRouter(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  fn: (c: MikrotikClient, username: string) => Promise<string>,
): Promise<void> {
  if (!user.hotspotRouterId || !user.hotspotUsername) {
    await ctx.reply(
      phone,
      card('⚠️ *Akun belum lengkap*', 'Nomor Anda tertaut, tapi belum ada akun hotspot — hubungi admin.'),
    );
    return;
  }
  const router = await ctx.prisma.routerMikrotik.findUnique({
    where: { id: user.hotspotRouterId },
  });
  if (!router) {
    await ctx.reply(phone, card('⚠️ *Router tidak ditemukan*', 'Router hotspot Anda tidak terdaftar — hubungi admin.'));
    return;
  }
  const c = clientForRouter(router);
  try {
    await ctx.reply(phone, await fn(c, user.hotspotUsername));
  } catch (err) {
    ctx.logger.warn({ err, user: user.id }, 'member router op failed');
    await ctx.reply(
      phone,
      card('⚠️ *Router offline*', `Router ${router.name} tidak bisa dihubungi saat ini.\nCoba lagi nanti.`),
    );
  } finally {
    await c.close();
  }
}

/** `status` — profile, device limit, quota, active sessions, blocked services. */
export async function memberStatus(ctx: BotCtx, phone: string, user: AppUser) {
  await withMemberRouter(ctx, phone, user, async (c, username) => {
    const s = await getMemberStatus(c, username);
    if (!s) return card('❌ *Akun tidak ada*', `Akun hotspot *${username}* tidak ditemukan di router.`);
    const used = (Number(s.bytesIn ?? 0) + Number(s.bytesOut ?? 0)).toString();
    const lines = [
      `👤 Profil: *${s.profile}* · ${s.devices} device${s.disabled ? ' · ⛔ NONAKTIF' : ''}`,
      `📶 Kuota: *${fmtQuota(used, s.limitBytesTotal)}*`,
      s.limitUptime ? `⏱️ Batas waktu: ${s.limitUptime}` : null,
      DIV,
      s.sessions.length > 0
        ? `🔌 *Sesi aktif (${s.sessions.length}):*\n${s.sessions
            .slice(0, 5)
            .map((x) => `   · ${x.address ?? '?'} ${x.uptime ?? ''}`)
            .join('\n')}`
        : '🔌 Tidak ada sesi aktif',
      s.blockedServices.length > 0
        ? `🚫 *Diblokir:* ${s.blockedServices.map((b) => b.label).join(', ')}`
        : null,
    ].filter(Boolean);
    return card(`📋 *Status Akun — ${s.username}*`, lines.filter((l): l is string => Boolean(l)), 'Ketik MENU untuk perintah lain');
  });
}

/** `logout`/`kick` — disconnect all of the member's own sessions. */
export async function memberKick(ctx: BotCtx, phone: string, user: AppUser) {
  await withMemberRouter(ctx, phone, user, async (c, username) => {
    const { kicked } = await kickMemberSessions(c, username);
    await ctx.prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: 'hotspot-self-kick',
          entity: 'app_user',
          entityId: user.id,
          after: { kicked, via: 'whatsapp' },
        },
      })
      .catch(() => undefined);
    return kicked === 0
      ? card('ℹ️ *Tidak ada sesi*', 'Tidak ada sesi aktif untuk dikeluarkan.')
      : card('✅ *Sesi dikeluarkan*', `*${kicked}* sesi Anda sudah diputus.\nAnda bisa login ulang kapan saja.`);
  });
}

/** `info` — service contact + portal link. Password changes never via chat. */
export async function memberInfo(ctx: BotCtx, phone: string) {
  const settings = await ctx.prisma.setting.findUnique({ where: { id: 'global' } });
  const name = settings?.orgName || 'NOC';
  await ctx.reply(
    phone,
    card(
      `ℹ️ *${name}*`,
      [
        `🌐 Portal: ${env.PUBLIC_BASE_URL}`,
        '🔑 Di portal Anda bisa: ganti password, lihat riwayat, tautkan WA',
      ],
      'Ketik MENU untuk perintah · KOMPLAIN untuk lapor gangguan',
    ),
  );
}

/** `tiket` — the member's own complaint tickets, newest first. */
export async function memberTickets(ctx: BotCtx, phone: string, user: AppUser) {
  const rows = await ctx.prisma.ticket.findMany({
    where: { memberId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { site: { select: { name: true } } },
  });
  if (rows.length === 0) {
    await ctx.reply(phone, card('🎫 *Tiket Anda*', 'Belum ada tiket.', 'Kirim KOMPLAIN <pesan> untuk melapor'));
    return;
  }
  const label = { open: '🟡 Open', ack: '🔧 Diproses', resolved: '✅ Selesai' } as const;
  const lines = rows.map((t) => {
    const code = t.id.slice(0, 6).toUpperCase();
    const status = label[t.status as keyof typeof label] ?? t.status;
    const when = t.createdAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `*#${code}* ${status}\n   ${t.site.name} · ${when}\n   "${t.message.slice(0, 80)}"` +
      (t.handledBy ? `\n   👷 ${t.handledBy}` : '');
  });
  await ctx.reply(phone, card(`🎫 *Tiket Anda* (${rows.length} terbaru)`, lines));
}

export const MEMBER_MENU = [
  '👤 *Menu Member*',
  cmd('STATUS', 'kuota, profil & sesi (alias: AKUN/KUOTA)'),
  cmd('TIKET', 'status komplain Anda'),
  cmd('KOMPLAIN <pesan>', 'lapor gangguan ke teknisi'),
  cmd('LOGOUT', 'keluarkan semua sesi'),
  cmd('INFO', 'kontak & portal'),
  DIV,
  '_Contoh: KOMPLAIN wifi mati di ruang packing_',
].join('\n');
