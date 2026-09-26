// =============================================================================
// Inbound command router. Dispatches private-chat text commands:
//
//   universal : LINK <kode> · PROSES/SELESAI <kode> · KOMPLAIN [teks]
//               (plus the multi-step anonymous complaint intake)
//   member    : STATUS · LOGOUT · INFO        (verified member numbers)
//   staff     : SITES · DOWN · ACK · PING · TIKET · LAPORAN
//   fallback  : MENU / unknown-number hint
//
// Security model: commands are gated by the sender's phone → verified AppUser
// (phone + phoneVerifiedAt). Unknown numbers only get the complaint intake and
// public replies — never staff/member data. Members only touch their OWN
// linked hotspot account. Staff reuse the shared RBAC site scope.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { REDIS_KEYS, normalizePhone, type WaInboundMessage } from '@noc/shared';
import { consumeWaLinkCode, getSettings, type Redis } from '@noc/server';
import { continueIntake, getConv, startComplaint } from './intake';
import { handleTicketCommand, type BotCtx } from './tickets';
import { BOT_TITLE, DIV, card, cmd, greetingFor } from './fmt';
import { MEMBER_MENU, memberInfo, memberKick, memberStatus, memberTickets } from './commands/member';
import {
  STAFF_MENU,
  staffAck,
  staffDown,
  staffPing,
  staffReport,
  staffSites,
  staffTickets,
} from './commands/staff';

/** Max inbound commands per phone per minute — beyond that we drop silently. */
const RATE_LIMIT_PER_MIN = 30;

interface RouterDeps {
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger;
  reply: (to: string, text: string) => Promise<void>;
}

const GREETING = /^(menu|help|bantuan|start|hai|halo|halo bot)$/i;

export class InboundRouter {
  constructor(private deps: RouterDeps) {}

  async handle(msg: WaInboundMessage): Promise<void> {
    // Commands are private-chat only — group messages are never acted on.
    if (msg.isGroup) return;

    // WA occasionally re-delivers; one reply per message id.
    if (msg.messageId) {
      const fresh = await this.deps.redis
        .set(REDIS_KEYS.waSeen(msg.messageId), '1', 'EX', 300, 'NX')
        .catch(() => 'OK');
      if (fresh !== 'OK') return;
    }

    if (!(await this.allowed(msg.from))) return;

    const text = msg.text.trim();
    if (!text) return;
    const phone = normalizePhone(msg.from);
    const ctx: BotCtx = { ...this.deps };

    try {
      await this.dispatch(ctx, phone, text);
    } catch (err) {
      this.deps.logger.error({ err, phone }, 'wa command failed');
      await ctx
        .reply(phone, card('⚠️ *Ups, ada gangguan*', 'Perintah gagal diproses — coba lagi sebentar.'))
        .catch(() => undefined);
    }
  }

  private async dispatch(ctx: BotCtx, phone: string, text: string): Promise<void> {
    // ---- LINK <kode>: bind this WA number to the portal account -------------
    const linkM = /^link\s+([A-Za-z0-9]{4,10})$/i.exec(text);
    if (linkM) {
      const userId = await consumeWaLinkCode(ctx.redis, linkM[1]!);
      if (!userId) {
        await ctx.reply(
          phone,
          card(
            '❌ *Kode tidak valid*',
            'Kode sudah kedaluwarsa atau salah ketik.\nAmbil kode baru di portal → menu *Akun*.',
          ),
        );
        return;
      }
      await ctx.prisma.appUser.update({
        where: { id: userId },
        data: { phone, phoneVerifiedAt: new Date() },
      });
      const u = await ctx.prisma.appUser.findUnique({ where: { id: userId } });
      await ctx.reply(
        phone,
        card(
          '✅ *Nomor tertaut!*',
          `Nomor ini sekarang terhubung ke akun *${u?.name ?? userId}*.`,
          'Ketik MENU untuk daftar perintah',
        ),
      );
      return;
    }

    // ---- PROSES / SELESAI <kode>: technician ticket workflow ----------------
    const ticketM = /^(proses|selesai)\s+([a-z0-9]{4,12})$/i.exec(text);
    if (ticketM) {
      await handleTicketCommand(
        ctx,
        phone,
        ticketM[1]!.toLowerCase() as 'proses' | 'selesai',
        ticketM[2]!,
      );
      return;
    }

    // ---- Pending complaint intake (anonymous wizard / member body) ----------
    const conv = await getConv(ctx.redis, phone);
    if (conv) {
      await continueIntake(ctx, phone, text, conv);
      return;
    }

    // ---- Identity: verified phone → AppUser --------------------------------
    const user = await ctx.prisma.appUser.findFirst({
      where: { phone, phoneVerifiedAt: { not: null }, isActive: true },
    });

    // ---- KOMPLAIN [teks]: works for anyone; members get context attached ----
    const komplainM = /^komplain\b[ \t]*/i.exec(text);
    if (komplainM) {
      const settings = await getSettings();
      if (!settings.waComplaintEnabled) {
        await ctx.reply(phone, 'Maaf, layanan komplain via WhatsApp sedang nonaktif.');
        return;
      }
      const inline = text.slice(komplainM[0].length).trim();
      await startComplaint(ctx, phone, inline, user?.role === 'member' ? user : null);
      return;
    }

    // ---- Universal ----------------------------------------------------------
    if (text.toLowerCase() === 'ping') {
      await ctx.reply(phone, card('✅ *Pong!*', 'NOC bot aktif dan merespons.'));
      return;
    }
    if (GREETING.test(text)) {
      await ctx.reply(phone, this.menuText(user?.role ?? null, user?.name));
      return;
    }

    // ---- Not linked → only the public menu + complaint hint -----------------
    if (!user) {
      await ctx.reply(phone, this.menuText(null));
      return;
    }

    // ---- Member commands ----------------------------------------------------
    if (user.role === 'member') {
      const cmd = text.toLowerCase();
      if (cmd === 'status') return memberStatus(ctx, phone, user);
      if (cmd === 'logout' || cmd === 'kick' || cmd === 'keluar')
        return memberKick(ctx, phone, user);
      if (cmd === 'tiket' || cmd === 'tickets') return memberTickets(ctx, phone, user);
      if (cmd === 'info') return memberInfo(ctx, phone);
      return ctx.reply(phone, this.menuText('member'));
    }

    // ---- Staff commands (viewer/operator/super_admin) ------------------------
    const staffM = /^(sites|status|down|ack|ping|tiket|tickets|laporan)\b[ \t]*(.*)$/i.exec(text);
    if (staffM) {
      const cmd = staffM[1]!.toLowerCase();
      const arg = (staffM[2] ?? '').trim();
      switch (cmd) {
        case 'sites':
        case 'status':
          return staffSites(ctx, phone, user);
        case 'down':
          return staffDown(ctx, phone, user, arg);
        case 'ack':
          return staffAck(ctx, phone, user, arg);
        case 'ping':
          return staffPing(ctx, phone, user, arg);
        case 'tiket':
        case 'tickets':
          return staffTickets(ctx, phone, user);
        case 'laporan':
          return staffReport(ctx, phone, user);
      }
    }
    return ctx.reply(phone, this.menuText('staff'));
  }

  private menuText(role: string | null, name?: string | null): string {
    if (role === 'member') return `${BOT_TITLE}\n${greetingFor(name)}\n${DIV}\n${MEMBER_MENU}`;
    if (role && role !== 'member') return `${BOT_TITLE}\n${greetingFor(name)}\n${DIV}\n${STAFF_MENU}`;
    return [
      BOT_TITLE,
      greetingFor(),
      DIV,
      'Saya bisa bantu hal berikut:',
      cmd('KOMPLAIN <pesan>', 'laporkan gangguan ke teknisi'),
      cmd('LINK <kode>', 'tautkan nomor ke akun portal'),
      cmd('PING', 'cek bot aktif'),
      DIV,
      '_Contoh: KOMPLAIN internet mati di gudang_',
    ].join('\n');
  }

  private async allowed(phone: string): Promise<boolean> {
    const key = REDIS_KEYS.waRate(phone);
    const n = await this.deps.redis.incr(key).catch(() => 0);
    if (n === 1) await this.deps.redis.expire(key, 60).catch(() => undefined);
    return n <= RATE_LIMIT_PER_MIN;
  }
}
