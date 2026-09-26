// =============================================================================
// Inbound command router. Dispatches private-chat text commands:
//
//   universal : LINK <kode> · PROSES/SELESAI <kode> · KOMPLAIN [teks]
//               (plus the multi-step anonymous complaint intake) · INFO
//   member    : STATUS · LOGOUT · TIKET · INFO  (verified member numbers)
//   staff     : SITES · DOWN · CEK · ACK/UNACK · MAINT/AKTIF · SILENT/BUNYI ·
//               PING · TIKET · LAPORAN · BOTSTATUS
//   recipient : WaRecipient numbers (no account) — read ops scoped to their
//               recipient sites (TIKET/DOWN/CEK/SITES/LAPORAN)
//   group     : PROSES/SELESAI (ticket replies) + staff read commands
//   fallback  : MENU / unknown-number hint
//
// Security model: commands are gated by the sender's phone → verified AppUser
// (phone + phoneVerifiedAt). Unknown numbers only get the complaint intake and
// public replies — never staff/member data. Members only touch their OWN
// linked hotspot account. Staff reuse the shared RBAC site scope. Groups see
// nothing personal — replies go back to the group JID.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import {
  REDIS_KEYS,
  hasPermission,
  normalizePhone,
  type Permission,
  type Role,
  type ScopedUser,
  type WaInboundMessage,
} from '@noc/shared';
import { consumeWaLinkCode, getSettings, type Redis } from '@noc/server';
import { continueIntake, getConv, startComplaint, startRegister } from './intake';
import { handleTicketCommand, type BotCtx } from './tickets';
import { BOT_TITLE, DIV, card, cmd, greetingFor } from './fmt';
import { MEMBER_MENU, memberInfo, memberKick, memberStatus, memberTickets } from './commands/member';
import {
  STAFF_MENU,
  scoped,
  staffAck,
  staffBotStatus,
  staffMaint,
  staffPing,
  staffRead,
  staffSilent,
  staffUnack,
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
    // Groups get a narrow surface (ticket ops + staff read commands) — the
    // full dispatch is private-chat only.
    if (msg.isGroup) {
      await this.handleGroup(msg);
      return;
    }

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
      const u = await ctx.prisma.appUser.findUnique({ where: { id: userId } });
      if (!u?.isActive) {
        await ctx.reply(phone, card('⛔ *Akun nonaktif*', 'Akun untuk kode ini sudah dinonaktifkan — hubungi admin.'));
        return;
      }
      // One phone = one identity: detach the number from any other account.
      await ctx.prisma.appUser.updateMany({
        where: { phone, id: { not: userId } },
        data: { phone: null, phoneVerifiedAt: null },
      });
      await ctx.prisma.appUser.update({
        where: { id: userId },
        data: { phone, phoneVerifiedAt: new Date() },
      });
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
    // Lay aliases map to the same flow — users type LAPOR/KELUHAN/GANGGUAN too.
    const komplainM = /^(komplain|lapor|keluhan|pengaduan|gangguan)\b[ \t]*/i.exec(text);
    if (komplainM) {
      const settings = await getSettings();
      if (!settings.waComplaintEnabled) {
        await ctx.reply(phone, card('⛔ *Layanan nonaktif*', 'Komplain via WhatsApp sedang nonaktif — hubungi admin.'));
        return;
      }
      const inline = text.slice(komplainM[0].length).trim();
      // Members take the member path; staff get the anonymous wizard pre-filled
      // from their account (startComplaint branches on role internally).
      await startComplaint(ctx, phone, inline, user);
      return;
    }

    // ---- DAFTAR: account-request wizard for brand-new numbers ----------------
    if (/^(daftar|register|registrasi)\b/i.test(text)) {
      if (user) {
        await ctx.reply(phone, card('ℹ️ *Sudah tertaut*', `Nomor ini sudah terhubung ke akun *${user.name}*.`, 'Ketik MENU untuk daftar perintah'));
        return;
      }
      await startRegister(ctx, phone);
      return;
    }

    // ---- Universal ----------------------------------------------------------
    if (text.toLowerCase() === 'ping' && !(user && user.role !== 'member')) {
      await ctx.reply(phone, card('✅ *Pong!*', 'NOC bot aktif dan merespons.'));
      return;
    }
    if (GREETING.test(text)) {
      await ctx.reply(phone, await this.menuText(user?.role ?? null, user?.name));
      return;
    }
    // INFO is universal — anonymous users also need the portal/contact card.
    if (/^info$/i.test(text)) {
      await memberInfo(ctx, phone);
      return;
    }

    // ---- Not linked → intents for lay users, then the public menu -----------
    if (!user) {
      const intent = this.publicIntent(text);
      if (intent) {
        await ctx.reply(phone, intent);
        return;
      }
      // A registered WaRecipient number (technician without an account) gets a
      // read-only ops view scoped to its recipient sites.
      const recipSites = await ctx.prisma.waRecipient.findMany({
        where: { target: phone, kind: 'number', isActive: true },
        select: { siteId: true },
        distinct: ['siteId'],
      });
      if (recipSites.length) {
        const rm = /^(sites|status|down|cek|tiket|tickets|laporan)\b[ \t]*(.*)$/i.exec(text);
        if (rm) {
          const pseudo: ScopedUser = {
            role: 'viewer',
            scopeSiteIds: recipSites.map((r) => r.siteId),
          };
          if (await staffRead(ctx, phone, pseudo, rm[1]!.toLowerCase(), (rm[2] ?? '').trim())) return;
        }
      }
      if (/^tiket\b/i.test(text)) {
        const rows = await ctx.prisma.ticket.findMany({
          where: { reporterPhone: phone, memberId: null },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { site: { select: { name: true } } },
        });
        if (rows.length === 0) {
          await ctx.reply(phone, card('🎫 *Tiket Anda*', 'Belum ada komplain dari nomor ini.', 'Kirim KOMPLAIN <pesan> untuk melapor'));
          return;
        }
        const label = { open: '🟡 Open', ack: '🔧 Diproses', resolved: '✅ Selesai' } as const;
        await ctx.reply(
          phone,
          card(
            '🎫 *Tiket Anda* (dari nomor ini)',
            rows.map((t) => {
              const code = t.id.slice(0, 6).toUpperCase();
              const st = label[t.status as keyof typeof label] ?? t.status;
              return `*#${code}* ${st}\n   ${t.site.name} — "${t.message.slice(0, 80)}"`;
            }),
          ),
        );
        return;
      }
      await ctx.reply(phone, await this.menuText(null));
      return;
    }

    // ---- Member commands ----------------------------------------------------
    if (user.role === 'member') {
      const cmd = text.toLowerCase();
      if (cmd === 'status' || cmd === 'akun' || cmd === 'kuota' || cmd === 'profil')
        return memberStatus(ctx, phone, user);
      if (cmd === 'logout' || cmd === 'kick' || cmd === 'keluar')
        return memberKick(ctx, phone, user);
      if (cmd === 'tiket' || cmd === 'tickets') return memberTickets(ctx, phone, user);
      if (cmd === 'info') return memberInfo(ctx, phone);
      return ctx.reply(phone, await this.menuText('member', user.name));
    }

    // ---- Staff commands (viewer/operator/super_admin) ------------------------
    const staffM =
      /^(sites|status|down|ack|unack|cek|ping|tiket|tickets|laporan|maint|maintenance|aktif|silent|unsilent|bunyi|bot|botstatus|wastatus)\b[ \t]*(.*)$/i.exec(
        text,
      );
    if (staffM) {
      const cmd = staffM[1]!.toLowerCase();
      const arg = (staffM[2] ?? '').trim();
      const need: Record<string, Permission> = {
        sites: 'map:view', status: 'map:view', down: 'device:view', cek: 'device:view',
        ack: 'alerts:manage', unack: 'alerts:manage', ping: 'device:diagnose',
        tiket: 'tickets:view', tickets: 'tickets:view', laporan: 'reports:view',
        maint: 'device:edit-attributes', maintenance: 'device:edit-attributes',
        aktif: 'device:edit-attributes',
        silent: 'alerts:manage', unsilent: 'alerts:manage', bunyi: 'alerts:manage',
        bot: 'whatsapp:manage', botstatus: 'whatsapp:manage', wastatus: 'whatsapp:manage',
      };
      const perm = need[cmd];
      if (perm && !hasPermission(user.role as Role, perm)) {
        await ctx.reply(
          phone,
          card('⛔ *Akses kurang*', `Perintah *${cmd.toUpperCase()}* butuh izin _${perm}_ — role Anda *${user.role}* tidak memilikinya.`),
        );
        return;
      }
      // Read commands share one dispatch with the group/recipient surfaces.
      if (await staffRead(ctx, phone, scoped(user), cmd, arg)) return;
      switch (cmd) {
        case 'ack':
          return staffAck(ctx, phone, user, arg);
        case 'unack':
          return staffUnack(ctx, phone, user, arg);
        case 'ping':
          return staffPing(ctx, phone, user, arg);
        case 'maint':
        case 'maintenance':
          return staffMaint(ctx, phone, user, arg, true);
        case 'aktif':
          return staffMaint(ctx, phone, user, arg, false);
        case 'silent':
          return staffSilent(ctx, phone, user, arg, true);
        case 'unsilent':
        case 'bunyi':
          return staffSilent(ctx, phone, user, arg, false);
        case 'bot':
        case 'botstatus':
        case 'wastatus':
          return staffBotStatus(ctx, phone);
      }
    }
    return ctx.reply(phone, await this.menuText('staff', user.name));
  }

  /** Lay-friendly keyword routing for numbers with no account. */
  private publicIntent(text: string): string | null {
    const t = text.toLowerCase();
    if (/gangguan|mati|rusak|error|lemot|lambat|internet|wifi|jaringan|putus/.test(t)) {
      return card(
        '📡 *Ada gangguan?*',
        'Sepertinya Anda mau melaporkan gangguan.',
        'Balas *KOMPLAIN* <keluhan> — contoh: KOMPLAIN wifi gudang mati',
      );
    }
    if (/voucher|top.?up|isi ulang|beli|bayar|harga|tagihan/.test(t)) {
      return card(
        '🎟️ *Voucher / Pembayaran*',
        'Pembelian voucher & pembayaran dilakukan lewat portal pelanggan.',
        'Ketik INFO untuk link portal · KOMPLAIN jika ada kendala',
      );
    }
    if (/akun|daftar|register|username|password|login/.test(t)) {
      return card(
        '🆕 *Soal Akun*',
        '• Belum punya akun? Ketik *DAFTAR* untuk permintaan akun baru.',
        '• Sudah punya akun portal? Minta kode di portal lalu kirim *LINK <kode>*.',
      );
    }
    return null;
  }

  private async menuText(role: string | null, name?: string | null): Promise<string> {
    const settings = await getSettings().catch(() => null);
    const title = `🤖 *${settings?.waBotName?.toUpperCase() || 'NOC BOT'} — ${settings?.orgName || 'RAF'}*`;
    if (role === 'member') return `${title}\n${greetingFor(name)}\n${DIV}\n${MEMBER_MENU}`;
    if (role && role !== 'member') return `${title}\n${greetingFor(name)}\n${DIV}\n${STAFF_MENU}`;
    return [
      title,
      greetingFor(),
      DIV,
      'Saya bisa bantu hal berikut:',
      cmd('KOMPLAIN <pesan>', 'laporkan gangguan ke teknisi'),
      cmd('TIKET', 'cek status komplain dari nomor ini'),
      cmd('DAFTAR', 'minta akun baru ke admin'),
      cmd('LINK <kode>', 'tautkan nomor ke akun portal'),
      cmd('INFO', 'kontak & portal pelanggan'),
      cmd('PING', 'cek bot aktif'),
      DIV,
      '_Contoh: KOMPLAIN internet mati di gudang_',
      '_Bisa juga: LAPOR / KELUHAN / GANGGUAN <keluhan>_',
      '_Nomor Anda hanya dipakai untuk update layanan NOC_',
    ].join('\n');
  }

  /**
   * Group chats get a deliberately narrow surface: ticket-workflow replies
   * (PROSES/SELESAI — ticket forwards to groups literally say "Balas PROSES")
   * plus read-only ops for verified staff. Member/public flows stay private —
   * answers would broadcast personal data to the whole group. Unrecognized or
   * unprivileged commands are ignored silently (no probing replies).
   */
  private async handleGroup(msg: WaInboundMessage): Promise<void> {
    const actor = msg.sender ? normalizePhone(msg.sender) : '';
    if (!actor) return;
    const text = msg.text.trim();
    if (!text) return;

    if (msg.messageId) {
      const fresh = await this.deps.redis
        .set(REDIS_KEYS.waSeen(msg.messageId), '1', 'EX', 300, 'NX')
        .catch(() => 'OK');
      if (fresh !== 'OK') return;
    }
    if (!(await this.allowed(actor))) return;

    const ctx: BotCtx = { ...this.deps };
    const groupJid = msg.from;
    try {
      const tm = /^(proses|selesai)\s+([a-z0-9]{4,12})$/i.exec(text);
      if (tm) {
        await handleTicketCommand(
          ctx,
          actor,
          groupJid,
          tm[1]!.toLowerCase() as 'proses' | 'selesai',
          tm[2]!,
        );
        return;
      }

      const user = await ctx.prisma.appUser.findFirst({
        where: { phone: actor, phoneVerifiedAt: { not: null }, isActive: true },
      });
      if (!user || user.role === 'member') return;

      const gm = /^(sites|status|down|cek|tiket|tickets|laporan)\b[ \t]*(.*)$/i.exec(text);
      if (!gm) return;
      const cmd = gm[1]!.toLowerCase();
      const need: Record<string, Permission> = {
        sites: 'map:view', status: 'map:view', down: 'device:view', cek: 'device:view',
        tiket: 'tickets:view', tickets: 'tickets:view', laporan: 'reports:view',
      };
      const perm = need[cmd];
      if (perm && !hasPermission(user.role as Role, perm)) return;
      await staffRead(ctx, groupJid, scoped(user), cmd, (gm[2] ?? '').trim());
    } catch (err) {
      this.deps.logger.warn({ err, group: groupJid }, 'wa group command failed');
    }
  }

  private async allowed(phone: string): Promise<boolean> {
    const key = REDIS_KEYS.waRate(phone);
    const n = await this.deps.redis.incr(key).catch(() => 0);
    if (n === 1) await this.deps.redis.expire(key, 60).catch(() => undefined);
    return n <= RATE_LIMIT_PER_MIN;
  }
}
