// =============================================================================
// Member self-service commands — the WhatsApp twin of the /akun page.
// Every action is scoped to the member's OWN linked hotspot account
// (AppUser.hotspotRouterId + hotspotUsername), exactly like me-hotspot.ts.
// =============================================================================

import type { AppUser, RouterMikrotik } from '@prisma/client';
import {
  clientForRouter,
  env,
  getMemberStatus,
  kickMemberSessions,
} from '@noc/server';
import type { MikrotikClient } from '@noc/server';
import type { BotCtx } from '../tickets';
import { DIV, ago, bar, card, cmd, kvBlock } from '../fmt';
import { outageLines, siteOutage } from '../outage';
import { withTimeout } from '../util';

/** Router ops shouldn't wait longer than this — silence reads as "bot stuck". */
const ROUTER_OP_TIMEOUT_MS = 25_000;

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

/** Open a client on the member's linked router, or null if unlinked. */
async function withMemberRouter(
  ctx: BotCtx,
  phone: string,
  user: AppUser,
  fn: (c: MikrotikClient, username: string, router: RouterMikrotik) => Promise<string>,
): Promise<void> {
  if (!user.hotspotRouterId || !user.hotspotUsername) {
    await ctx.reply(
      phone,
      card(
        '⚠️ *Akun belum lengkap*',
        'Nomor Anda tertaut, tapi belum ada akun hotspot yang terhubung.',
        'Hubungi admin untuk penautan akun hotspot',
      ),
    );
    return;
  }
  const router = await ctx.prisma.routerMikrotik.findUnique({
    where: { id: user.hotspotRouterId },
  });
  if (!router) {
    await ctx.reply(
      phone,
      card('⚠️ *Router tidak ditemukan*', 'Router hotspot Anda tidak terdaftar di NOC.', 'Hubungi admin untuk memeriksa konfigurasi'),
    );
    return;
  }
  const c = clientForRouter(router);
  try {
    await ctx.reply(
      phone,
      await withTimeout(fn(c, user.hotspotUsername, router), ROUTER_OP_TIMEOUT_MS, 'router op'),
    );
  } catch (err) {
    ctx.logger.warn({ err, user: user.id }, 'member router op failed');
    await ctx.reply(
      phone,
      card(
        '⚠️ *Router tidak merespons*',
        `Router *${router.name}* tidak bisa dihubungi saat ini — status mungkin sedang gangguan.`,
        'Coba lagi beberapa menit · KOMPLAIN <pesan> bila mendesak',
      ),
    );
  } finally {
    await c.close();
  }
}

/** Quota usage line: used/limit + a meter + remaining, when a limit exists. */
function quotaLines(usedBytes: string, limitBytes: string | null): string[] {
  const used = Number(usedBytes ?? 0);
  const limit = Number(limitBytes ?? 0);
  if (!Number.isFinite(limit) || limit <= 0) {
    return [`Kuota   : *${fmtBytes(usedBytes)}* terpakai (tanpa limit)`];
  }
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const left = Math.max(0, limit - used);
  return [
    `Kuota   : *${fmtBytes(usedBytes)} / ${fmtBytes(limitBytes)}*`,
    `${bar(pct)} ${pct}% — sisa *${fmtBytes(String(left))}*`,
  ];
}

/** `status` — profile, device limit, quota, active sessions, blocked services. */
export async function memberStatus(ctx: BotCtx, phone: string, user: AppUser) {
  await withMemberRouter(ctx, phone, user, async (c, username, router) => {
    const s = await getMemberStatus(c, username);
    if (!s) {
      return card(
        '❌ *Akun tidak ada*',
        `Akun hotspot *${username}* tidak ditemukan di router *${router.name}*.`,
        'Hubungi admin — kemungkinan akun dihapus dari router',
      );
    }
    const used = (Number(s.bytesIn ?? 0) + Number(s.bytesOut ?? 0)).toString();
    // Site-wide outage banner first — "we already know" beats a status read.
    const outage = await siteOutage(ctx, router.siteId).catch(() => null);
    const lines = [
      ...(outage ? [...outageLines(outage, 'member'), DIV] : []),
      ...kvBlock([
        ['Profil', `*${s.profile}* · maks ${s.devices} device`],
        ['Status', s.disabled ? '⛔ NONAKTIF — hubungi admin' : '✅ Aktif'],
      ]),
      // Meter row doesn't fit kvBlock — quota lines pad themselves to match.
      ...quotaLines(used, s.limitBytesTotal),
      s.limitUptime ? `⏱️ Batas waktu: ${s.limitUptime}` : null,
      DIV,
      s.sessions.length > 0
        ? `🔌 *Sesi aktif (${s.sessions.length}/${s.devices}):*\n${s.sessions
            .slice(0, 5)
            .map((x) => `   · ${x.address ?? '?'} ${x.uptime ?? ''}`)
            .join('\n')}`
        : '🔌 Tidak ada perangkat yang sedang login',
      s.sessions.length > 0 ? '_Ketik LOGOUT untuk mengeluarkan semua sesi_' : null,
      s.blockedServices.length > 0
        ? `🚫 *Diblokir:* ${s.blockedServices.map((b) => b.label).join(', ')}`
        : null,
    ].filter((l): l is string => Boolean(l));
    return card(`📋 *Status Akun — ${s.username}*`, lines, 'MENU untuk perintah lain · KOMPLAIN untuk lapor gangguan');
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
      ? card('ℹ️ *Tidak ada sesi aktif*', `Akun *${username}* tidak punya sesi yang sedang login — tidak ada yang perlu dikeluarkan.`)
      : card(
          '✅ *Sesi dikeluarkan*',
          `*${kicked}* sesi pada akun *${username}* sudah diputus.`,
          'Login ulang kapan saja · ketik STATUS untuk cek sesi',
        );
  });
}

/** `info` — service contact + portal link. Password changes never via chat. */
export async function memberInfo(ctx: BotCtx, phone: string) {
  const settings = await ctx.prisma.setting.findUnique({ where: { id: 'global' } });
  const name = settings?.orgName || 'NOC';
  await ctx.reply(
    phone,
    card(
      `ℹ️ *${name} — Info Layanan*`,
      [
        `🌐 Portal   : ${env.PUBLIC_BASE_URL}`,
        '🔑 Di portal: ganti password · lihat riwayat · tautkan WA',
        '🎫 Lewat sini: KOMPLAIN <keluhan> · TIKET untuk status',
      ],
      'Ganti password hanya lewat portal — bukan lewat chat',
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
    await ctx.reply(
      phone,
      card(
        '🎫 *Tiket Anda*',
        'Belum ada komplain yang tercatat dari akun Anda.',
        'Kirim KOMPLAIN <keluhan> untuk membuat tiket',
      ),
    );
    return;
  }
  const label = { open: '🟡 Open', ack: '🔧 Diproses', resolved: '✅ Selesai' } as const;
  const lines = rows.map((t) => {
    const code = t.id.slice(0, 6).toUpperCase();
    const status = label[t.status as keyof typeof label] ?? t.status;
    const when = t.createdAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `*#${code}* ${status} · ${ago(t.createdAt.toISOString())} lalu\n   ${t.site.name} · ${when} WIB\n   "${t.message.slice(0, 80)}"` +
      (t.handledBy ? `\n   👷 ${t.handledBy}` : '');
  });
  await ctx.reply(
    phone,
    card(`🎫 *Tiket Anda* (${rows.length} terbaru)`, lines, 'KOMPLAIN <keluhan> untuk tiket baru'),
  );
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
