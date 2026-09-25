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
      'Nomor Anda tertaut, tapi akun ini belum punya akun hotspot — hubungi admin.',
    );
    return;
  }
  const router = await ctx.prisma.routerMikrotik.findUnique({
    where: { id: user.hotspotRouterId },
  });
  if (!router) {
    await ctx.reply(phone, 'Router hotspot Anda tidak ditemukan — hubungi admin.');
    return;
  }
  const c = clientForRouter(router);
  try {
    await ctx.reply(phone, await fn(c, user.hotspotUsername));
  } catch (err) {
    ctx.logger.warn({ err, user: user.id }, 'member router op failed');
    await ctx.reply(
      phone,
      `⚠️ Router ${router.name} tidak bisa dihubungi saat ini. Coba lagi nanti.`,
    );
  } finally {
    await c.close();
  }
}

/** `status` — profile, device limit, quota, active sessions, blocked services. */
export async function memberStatus(ctx: BotCtx, phone: string, user: AppUser) {
  await withMemberRouter(ctx, phone, user, async (c, username) => {
    const s = await getMemberStatus(c, username);
    if (!s) return `Akun hotspot *${username}* tidak ditemukan di router.`;
    const used = (Number(s.bytesIn ?? 0) + Number(s.bytesOut ?? 0)).toString();
    const lines = [
      `📋 *Status Akun — ${s.username}*`,
      `👤 Profil: ${s.profile} · ${s.devices} device${s.disabled ? ' · NONAKTIF' : ''}`,
      `📶 Kuota: ${fmtQuota(used, s.limitBytesTotal)}`,
      s.limitUptime ? `⏱️ Batas waktu: ${s.limitUptime}` : null,
      s.sessions.length > 0
        ? `🔌 Sesi aktif (${s.sessions.length}):\n${s.sessions
            .slice(0, 5)
            .map((x) => `  · ${x.address ?? '?'} ${x.uptime ?? ''}`)
            .join('\n')}`
        : '🔌 Tidak ada sesi aktif',
      s.blockedServices.length > 0
        ? `🚫 Diblokir: ${s.blockedServices.map((b) => b.label).join(', ')}`
        : null,
    ].filter(Boolean);
    return lines.join('\n');
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
      ? 'Tidak ada sesi aktif untuk dikeluarkan.'
      : `✅ ${kicked} sesi Anda dikeluarkan. Anda bisa login ulang kapan saja.`;
  });
}

/** `info` — service contact + portal link. Password changes never via chat. */
export async function memberInfo(ctx: BotCtx, phone: string) {
  const settings = await ctx.prisma.setting.findUnique({ where: { id: 'global' } });
  const name = settings?.orgName || 'NOC';
  await ctx.reply(
    phone,
    [
      `ℹ️ *${name}*`,
      `Portal pelanggan: ${env.PUBLIC_BASE_URL}`,
      'Login portal untuk: ganti password, riwayat, dan tautkan nomor WA.',
      'Ketik MENU untuk daftar perintah, KOMPLAIN untuk lapor gangguan.',
    ].join('\n'),
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
    await ctx.reply(phone, 'Belum ada tiket — kirim KOMPLAIN <pesan> untuk melapor.');
    return;
  }
  const label = { open: '🟡 Open', ack: '🔧 Diproses', resolved: '✅ Selesai' } as const;
  const lines = rows.map((t) => {
    const code = t.id.slice(0, 6).toUpperCase();
    const status = label[t.status as keyof typeof label] ?? t.status;
    return `#${code} ${status} · ${t.site.name} — "${t.message.slice(0, 60)}"`;
  });
  await ctx.reply(phone, `🎫 *Tiket Anda (${rows.length} terbaru)*\n${lines.join('\n')}`);
}

export const MEMBER_MENU = [
  '*Menu Member*',
  '• STATUS — kuota, profil, sesi aktif',
  '• LOGOUT — keluarkan semua sesi Anda',
  '• TIKET — status komplain Anda',
  '• KOMPLAIN <pesan> — lapor gangguan ke teknisi',
  '• INFO — kontak & portal',
].join('\n');
