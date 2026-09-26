// =============================================================================
// Inbound command router. Dispatches private-chat text commands:
//
//   universal : LINK <kode> · PROSES/SELESAI <kode> · KOMPLAIN [teks]
//               (plus the multi-step anonymous complaint intake) · INFO
//   member    : STATUS · LOGOUT · TIKET · INFO  (verified member numbers)
//   staff     : SITES · DOWN · CEK · ACK/UNACK · MAINT/AKTIF · SILENT/BUNYI ·
//               PING · TIKET · LAPORAN · BOTSTATUS · WADEAD · KIRIMULANG
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
import { clearConv, continueIntake, getConv, startComplaint, startRegister } from './intake';
import { handleTicketCommand, type BotCtx } from './tickets';
import { DIV, ago, card, cmd, greetingFor } from './fmt';
import { MEMBER_MENU, memberInfo, memberKick, memberStatus, memberTickets } from './commands/member';
import {
  STAFF_MENU,
  scoped,
  staffAck,
  staffBotStatus,
  staffMaint,
  staffPickResolve,
  staffPing,
  staffRead,
  staffSilent,
  staffUnack,
  staffWaDead,
  staffWaRetry,
} from './commands/staff';

/** Max inbound commands per phone per minute — beyond that we drop silently. */
const RATE_LIMIT_PER_MIN = 30;

interface RouterDeps {
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger;
  reply: (to: string, text: string) => Promise<void>;
}

/** Friendly openings Indonesians actually send — not just literal "menu". */
const GREETING =
  /^(menu|help|bantuan|tolong|start|hai+|halo+|hei|hi|hello|tes|test|coba|halo bot|p|permisi|admin|pak|bu|ibu|mas|mbak|kak|bang|ass?alamu\S*|selamat(\s+(pagi|siang|sore|malam|datang))?|pagi|siang|sore|malam)$/i;

/** Courtesy one-worders — answer briefly instead of dumping the full menu. */
const SMALLTALK =
  /^(terima ?kasih|makasih|mks|tengkyu|thanks?|thx|suwun|nuwun|maturnuwun|trims|oke|ok+|okay|okey|siap|sip|noted?|baik|mantap|keren|top|jos|aman|iya|iya +pak|y+|ya)$/i;

/**
 * A pending wizard used to swallow ANY text for up to 15 minutes — a user who
 * wandered off and typed STATUS got silence-ish confusion ("bot stuck").
 * Command-looking input (and fresh greetings) now exits the wizard and runs
 * as a command instead. Wizard nav words (BATAL/KEMBALI/0/KELUAR) and courtesy
 * words are deliberately NOT listed — they keep their in-wizard meaning.
 */
const COMMANDISH =
  /^(menu|help|bantuan|info|status|akun|kuota|profil|tiket|tickets|sites|down|cek|ack|unack|ping|laporan|maint|maintenance|aktif|silent|unsilent|bunyi|bot|botstatus|wastatus|wadead|kirimulang|komplain|lapor|keluhan|pengaduan|gangguan|daftar|register|logout|kick|link|hai+|halo+|hei|hi|hello|pagi|siang|sore|malam|selamat|tes|test|coba|permisi|p)\b/i;

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

    const phone = normalizePhone(msg.from);
    if (!(await this.allowed(phone, phone))) return;

    const text = msg.text.trim();
    if (!text) {
      // Attachments arrive with no text — silence here is the classic "bot
      // mati" signal. Acknowledge once per window (a photo burst shouldn't
      // spam back), and steer them to the text complaint path.
      if (msg.media) await this.mediaNote(phone, msg.media);
      return;
    }
    const ctx: BotCtx = { ...this.deps };

    try {
      await this.dispatch(ctx, phone, msg);
    } catch (err) {
      this.deps.logger.error({ err, phone }, 'wa command failed');
      await ctx
        .reply(
          phone,
          card(
            '⚠️ *Ups, ada gangguan*',
            'Perintah gagal diproses — ini gangguan sementara di sisi bot.',
            'Coba kirim ulang · ketik MENU bila butuh daftar perintah',
          ),
        )
        .catch(() => undefined);
    }
  }

  /**
   * Split `PROSES|SELESAI <rest>` into code + note. Quoting a ticket card
   * supplies the code from its #CODE — words like "udah beres" there are a
   * NOTE (they'd otherwise pattern-match as a bogus code). A lone token that
   * ISN'T the quoted code still counts as an explicit override.
   */
  private ticketCodeFrom(rest: string, msg: WaInboundMessage): { code?: string; note?: string } {
    const quoted = /#([a-z0-9]{4,12})/i.exec(msg.quotedText ?? '')?.[1]?.toLowerCase();
    if (quoted) {
      const lone = /^([a-z0-9]{4,12})$/i.exec(rest)?.[1]?.toLowerCase();
      if (lone && lone !== quoted) return { code: lone };
      return { code: quoted, note: rest && rest.toLowerCase() !== quoted ? rest : undefined };
    }
    const codeM = /^([a-z0-9]{4,12})\b[ \t]*(.*)$/i.exec(rest);
    return { code: codeM?.[1]?.toLowerCase(), note: codeM?.[2]?.trim() || undefined };
  }

  private async dispatch(ctx: BotCtx, phone: string, msg: WaInboundMessage): Promise<void> {
    const text = msg.text.trim();
    // ---- LINK <kode>: bind this WA number to the portal account -------------
    const linkM = /^link\s+([A-Za-z0-9]{4,10})$/i.exec(text);
    if (linkM) {
      const userId = await consumeWaLinkCode(ctx.redis, linkM[1]!);
      if (!userId) {
        await ctx.reply(
          phone,
          card(
            '❌ *Kode tidak valid*',
            'Kode kedaluwarsa (berlaku 10 menit) atau salah ketik.',
            'Ambil kode baru: portal → menu Akun → Tautkan WhatsApp',
          ),
        );
        return;
      }
      const u = await ctx.prisma.appUser.findUnique({ where: { id: userId } });
      if (!u?.isActive) {
        await ctx.reply(
          phone,
          card('⛔ *Akun nonaktif*', 'Akun untuk kode ini sudah dinonaktifkan.', 'Hubungi admin untuk mengaktifkan kembali'),
        );
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
        await this.menuText(
          u?.role === 'member' ? 'member' : 'staff',
          u?.name,
          `✅ Nomor ini tertaut ke akun *${u?.name ?? 'Anda'}* (${u?.role === 'member' ? 'member' : 'staff'}).`,
        ),
      );
      return;
    }

    // ---- PROSES / SELESAI [kode] [catatan]: technician ticket workflow ------
    // Bare `SELESAI` also works as a reply to the forwarded ticket card — the
    // code comes from the quoted text; anything typed after counts as a note.
    const ticketM = /^(proses|selesai)\b[ \t]*(.*)$/i.exec(text);
    if (ticketM) {
      const { code, note } = this.ticketCodeFrom((ticketM[2] ?? '').trim(), msg);
      if (!code) {
        await ctx.reply(
          phone,
          card('ℹ️ *Cara pakai*', '*PROSES/SELESAI* <kode-tiket> [catatan]', 'Atau balas kartu tiket langsung dengan PROSES/SELESAI'),
        );
        return;
      }
      await handleTicketCommand(
        ctx,
        phone,
        phone,
        ticketM[1]!.toLowerCase() as 'proses' | 'selesai',
        code,
        note,
      );
      return;
    }

    // ---- Pending complaint intake (anonymous wizard / member body) ----------
    const conv = await getConv(ctx.redis, phone);
    if (conv) {
      if (COMMANDISH.test(text)) {
        // Looks like a command, not a wizard answer — drop the stale conv and
        // fall through to normal dispatch so the bot never feels "stuck".
        await clearConv(ctx.redis, phone).catch(() => undefined);
      } else {
        await continueIntake(ctx, phone, text, conv);
        return;
      }
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
        await ctx.reply(
          phone,
          card(
            '⛔ *Layanan nonaktif*',
            'Komplain via WhatsApp sedang dinonaktifkan admin.',
            'Ketik INFO untuk kontak & portal pelanggan',
          ),
        );
        return;
      }
      const inline = text.slice(komplainM[0].length).trim();
      // Members take the member path; staff get the anonymous wizard pre-filled
      // from their account (startComplaint branches on role internally).
      await startComplaint(ctx, phone, inline, user, msg.pushName);
      return;
    }

    // ---- DAFTAR: account-request wizard for brand-new numbers ----------------
    if (/^(daftar|register|registrasi)\b/i.test(text)) {
      if (user) {
        await ctx.reply(phone, card('ℹ️ *Sudah tertaut*', `Nomor ini sudah terhubung ke akun *${user.name}* (${user.role === 'member' ? 'member' : 'staff'}).`, 'Ketik MENU untuk daftar perintah'));
        return;
      }
      await startRegister(ctx, phone, msg.pushName);
      return;
    }

    // ---- Universal ----------------------------------------------------------
    if (/^(p|ping)$/i.test(text) && !(user && user.role !== 'member')) {
      await ctx.reply(phone, card('✅ *Pong!*', 'NOC bot aktif dan merespons.', 'Ketik MENU untuk daftar perintah'));
      return;
    }
    // A registered site contact (WaRecipient, no account) isn't "anonymous" —
    // they get their own ops menu instead of the member-recruitment one.
    if (GREETING.test(text)) {
      if (!user && (await this.recipientSiteIds(ctx, phone)).length) {
        await ctx.reply(phone, await this.recipientMenu(msg.pushName));
        return;
      }
      await ctx.reply(phone, await this.menuText(user ? (user.role === 'member' ? 'member' : 'staff') : null, user?.name ?? msg.pushName));
      return;
    }
    // "makasih" / "ok" deserve a human-scale ack, not the whole menu again.
    if (SMALLTALK.test(text)) {
      const who = user?.name ?? msg.pushName;
      await ctx.reply(
        phone,
        card('🙏 *Siap!*', `Sama-sama${who ? `, *${who}*` : ''} — senang bisa membantu.`, 'Ketik MENU bila butuh lagi'),
      );
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
      // read-only ops view scoped to its recipient sites — and its own menu,
      // not the member-recruitment one.
      const recipSites = await this.recipientSiteIds(ctx, phone);
      if (recipSites.length) {
        const rm = /^(sites|status|down|cek|tiket|tickets|laporan)\b[ \t]*(.*)$/i.exec(text);
        if (rm) {
          const pseudo: ScopedUser = {
            role: 'viewer',
            scopeSiteIds: recipSites,
          };
          if (await staffRead(ctx, phone, pseudo, rm[1]!.toLowerCase(), (rm[2] ?? '').trim())) return;
        }
        await ctx.reply(phone, await this.recipientMenu(msg.pushName));
        return;
      }
      if (/^tiket\b/i.test(text)) {
        const rows = await ctx.prisma.ticket.findMany({
          where: { reporterPhone: phone, memberId: null },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { site: { select: { name: true } } },
        });
        if (rows.length === 0) {
          await ctx.reply(
            phone,
            card(
              '🎫 *Tiket Anda*',
              'Belum ada komplain yang tercatat dari nomor ini.',
              'Kirim KOMPLAIN <keluhan> untuk membuat tiket',
            ),
          );
          return;
        }
        const label = { open: '🟡 Open', ack: '🔧 Diproses', resolved: '✅ Selesai' } as const;
        await ctx.reply(
          phone,
          card(
            `🎫 *Tiket Anda* (${rows.length} terbaru)`,
            rows.map((t) => {
              const code = t.id.slice(0, 6).toUpperCase();
              const st = label[t.status as keyof typeof label] ?? t.status;
              return `*#${code}* ${st} · ${ago(t.createdAt.toISOString())} lalu\n   ${t.site.name} — "${t.message.slice(0, 80)}"`;
            }),
            'KOMPLAIN <keluhan> untuk tiket baru',
          ),
        );
        return;
      }
      await ctx.reply(phone, await this.menuText(null, msg.pushName));
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
      return ctx.reply(phone, await this.menuText('member', user.name ?? msg.pushName));
    }

    // ---- Staff commands (viewer/operator/super_admin) ------------------------
    // A pending numbered pick wins over new commands — "2" after the
    // "terlalu umum" list selects candidate #2 instead of starting fresh.
    if (await staffPickResolve(ctx, phone, user, text)) return;
    const staffM =
      /^(sites|status|down|ack|unack|cek|ping|tiket|tickets|laporan|maint|maintenance|aktif|silent|unsilent|bunyi|bot|botstatus|wastatus|wadead|kirimulang)\b[ \t]*(.*)$/i.exec(
        text,
      );
    if (staffM) {
      const cmd = staffM[1]!.toLowerCase();
      let arg = (staffM[2] ?? '').trim();
      // `TIKET` bare while quoting a ticket card → its #CODE is the arg.
      if (!arg && (cmd === 'tiket' || cmd === 'tickets')) {
        arg = /#([a-z0-9]{4,12})/i.exec(msg.quotedText ?? '')?.[1]?.toLowerCase() ?? '';
      }
      const need: Record<string, Permission> = {
        sites: 'map:view', status: 'map:view', down: 'device:view', cek: 'device:view',
        ack: 'alerts:manage', unack: 'alerts:manage', ping: 'device:diagnose',
        tiket: 'tickets:view', tickets: 'tickets:view', laporan: 'reports:view',
        maint: 'device:edit-attributes', maintenance: 'device:edit-attributes',
        aktif: 'device:edit-attributes',
        silent: 'alerts:manage', unsilent: 'alerts:manage', bunyi: 'alerts:manage',
        bot: 'whatsapp:manage', botstatus: 'whatsapp:manage', wastatus: 'whatsapp:manage',
        wadead: 'whatsapp:manage', kirimulang: 'whatsapp:manage',
      };
      const perm = need[cmd];
      if (perm && !hasPermission(user.role as Role, perm)) {
        await ctx.reply(
          phone,
          card(
            '⛔ *Akses kurang*',
            `Perintah *${cmd.toUpperCase()}* butuh izin _${perm}_ — role Anda *${user.role}* tidak memilikinya.`,
            'Ketik MENU untuk perintah yang tersedia bagi Anda',
          ),
        );
        return;
      }
      // Read commands share one dispatch with the group/recipient surfaces —
      // private chat is the only surface that offers numbered picks.
      if (await staffRead(ctx, phone, scoped(user), cmd, arg, { picks: true })) return;
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
        case 'wadead':
          return staffWaDead(ctx, phone);
        case 'kirimulang':
          return staffWaRetry(ctx, phone, arg);
      }
    }
    return ctx.reply(phone, await this.menuText('staff', user.name ?? msg.pushName));
  }

  /** Lay-friendly keyword routing for numbers with no account. */
  private publicIntent(text: string): string | null {
    const t = text.toLowerCase();
    if (/gangguan|mati|rusak|error|lemot|lambat|internet|wifi|jaringan|putus|cctv|kamera|printer|aplikasi|vpn|email|server|absen|finger ?print/.test(t)) {
      return card(
        '📡 *Ada gangguan?*',
        'Sepertinya Anda mau melaporkan gangguan jaringan.',
        'Balas *KOMPLAIN <keluhan>* — contoh: KOMPLAIN wifi gudang mati',
      );
    }
    if (/voucher|top.?up|isi ulang|beli|bayar|harga|tagihan/.test(t)) {
      return card(
        '🎟️ *Voucher & Pembayaran*',
        'Pembelian voucher dan pembayaran lewat portal pelanggan — bot ini tidak memproses pembayaran.',
        'Ketik INFO untuk link portal · KOMPLAIN <keluhan> bila ada kendala',
      );
    }
    if (/akun|daftar|register|username|password|login/.test(t)) {
      return card(
        '🆕 *Soal Akun*',
        [
          '• Belum punya akun → ketik *DAFTAR* (permintaan ke admin)',
          '• Sudah punya akun portal → minta kode di portal, kirim *LINK <kode>*',
          '• Lupa password → lewat portal, bukan chat ini',
        ],
      );
    }
    return null;
  }

  /**
   * The one menu card. `note` injects a status line right under the greeting
   * (e.g. the LINK success banner) so confirmations double as orientation.
   * `name` is the best-known display name — account name for linked users,
   * else the WhatsApp pushName.
   */
  private async menuText(
    role: 'member' | 'staff' | null,
    name?: string | null,
    note?: string,
  ): Promise<string> {
    const settings = await getSettings().catch(() => null);
    const title = `🤖 *${settings?.waBotName?.toUpperCase() || 'NOC BOT'} — ${settings?.orgName || 'RAF'}*`;
    const head = [title, greetingFor(name), ...(note ? [note] : []), DIV];
    if (role === 'member') return `${head.join('\n')}\n${MEMBER_MENU}`;
    if (role === 'staff') return `${head.join('\n')}\n${STAFF_MENU}`;
    return [
      ...head,
      '📌 _Nomor ini belum tertaut ke akun._',
      'Yang bisa saya bantu:',
      cmd('KOMPLAIN <keluhan>', 'lapor gangguan ke teknisi'),
      cmd('TIKET', 'status komplain dari nomor ini'),
      cmd('LINK <kode>', 'sudah punya akun portal? tautkan di sini'),
      cmd('DAFTAR', 'belum punya akun? minta ke admin'),
      cmd('INFO', 'kontak & portal pelanggan'),
      DIV,
      '_Bisa juga tulis langsung: "wifi gudang mati"_',
      '_Alias komplain: LAPOR / KELUHAN / GANGGUAN_',
    ].join('\n');
  }

  /** Sites this phone is a registered WaRecipient for (technician w/o account). */
  private async recipientSiteIds(ctx: BotCtx, phone: string): Promise<string[]> {
    const rows = await ctx.prisma.waRecipient.findMany({
      where: { target: phone, kind: 'number', isActive: true },
      select: { siteId: true },
      distinct: ['siteId'],
    });
    return rows.map((r) => r.siteId);
  }

  /** Menu for WaRecipient numbers — registered contacts, not strangers. */
  private async recipientMenu(name?: string): Promise<string> {
    const settings = await getSettings().catch(() => null);
    const title = `🤖 *${settings?.waBotName?.toUpperCase() || 'NOC BOT'} — ${settings?.orgName || 'RAF'}*`;
    return [
      title,
      greetingFor(name),
      `📌 Nomor ini terdaftar sebagai *kontak teknisi*.`,
      DIV,
      cmd('SITES', 'ringkasan site Anda'),
      cmd('DOWN [site]', 'perangkat down saat ini'),
      cmd('CEK <nama|ip>', 'status satu perangkat'),
      cmd('TIKET [kode]', 'tiket site Anda'),
      cmd('LAPORAN [site]', 'digest 24 jam'),
      cmd('PROSES/SELESAI <kode>', 'kerjakan tiket'),
      DIV,
      '_Akses penuh? Minta akun ke admin → lalu LINK <kode>_',
    ].join('\n');
  }

  /** Polite "can't read attachments" — throttled so a sticker/photo burst
   *  triggers one reply, not one per image. */
  private async mediaNote(phone: string, media: string): Promise<void> {
    const fresh = await this.deps.redis
      .set(REDIS_KEYS.waMediaNote(phone), '1', 'EX', 240, 'NX')
      .catch(() => null);
    if (fresh !== 'OK') return;
    await this.deps
      .reply(
        phone,
        card(
          `📎 *${media.charAt(0).toUpperCase() + media.slice(1)} diterima*`,
          'Bot ini membaca teks saja — lampiran tidak bisa saya lihat.',
          'Jelaskan lewat teks: *KOMPLAIN <keluhan>* · ketik MENU untuk bantuan',
        ),
      )
      .catch(() => undefined);
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
    if (!(await this.allowed(actor, actor))) return;

    const ctx: BotCtx = { ...this.deps };
    const groupJid = msg.from;
    try {
      const tm = /^(proses|selesai)\b[ \t]*(.*)$/i.exec(text);
      if (tm) {
        const { code, note } = this.ticketCodeFrom((tm[2] ?? '').trim(), msg);
        if (!code) return;
        await handleTicketCommand(
          ctx,
          actor,
          groupJid,
          tm[1]!.toLowerCase() as 'proses' | 'selesai',
          code,
          note,
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
      let arg = (gm[2] ?? '').trim();
      // `TIKET` bare as a reply to a forwarded card → detail of that ticket.
      if (!arg && (cmd === 'tiket' || cmd === 'tickets')) {
        arg = /#([a-z0-9]{4,12})/i.exec(msg.quotedText ?? '')?.[1]?.toLowerCase() ?? '';
      }
      const need: Record<string, Permission> = {
        sites: 'map:view', status: 'map:view', down: 'device:view', cek: 'device:view',
        tiket: 'tickets:view', tickets: 'tickets:view', laporan: 'reports:view',
      };
      const perm = need[cmd];
      if (perm && !hasPermission(user.role as Role, perm)) return;
      await staffRead(ctx, groupJid, scoped(user), cmd, arg);
    } catch (err) {
      this.deps.logger.warn({ err, group: groupJid }, 'wa group command failed');
    }
  }

  private async allowed(phone: string, notifyTo?: string): Promise<boolean> {
    const key = REDIS_KEYS.waRate(phone);
    const n = await this.deps.redis.incr(key).catch(() => 0);
    if (n === 1) await this.deps.redis.expire(key, 60).catch(() => undefined);
    if (n <= RATE_LIMIT_PER_MIN) return true;
    // Say it once a minute — total silence reads as "bot mati" to senders.
    if (notifyTo) {
      const noted = await this.deps.redis
        .set(REDIS_KEYS.waRateNote(phone), '1', 'EX', 60, 'NX')
        .catch(() => null);
      if (noted === 'OK') {
        await this.deps
          .reply(
            notifyTo,
            card(
              '🐢 *Terlalu cepat*',
              `Batas ${RATE_LIMIT_PER_MIN} pesan/menit tercapai — pesan Anda sementara diabaikan.`,
              'Tunggu ±1 menit lalu kirim ulang',
            ),
          )
          .catch(() => undefined);
      }
    }
    return false;
  }
}
