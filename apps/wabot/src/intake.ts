// =============================================================================
// Intake wizards — per-phone conversation state in Redis (noc:wa:conv:<phone>).
//
//   complaint (anonymous): name → dept → site → message
//   complaint (member):    (site from hotspot router) dept once → message,
//                          or `komplain <teks>` inline → dept once → done
//   register  (anonymous): name → dept → site → request ticket (category lainnya)
//
// Navigation at any step: BATAL or MENU exits; 0 / KEMBALI goes one step back.
// A linked member WITHOUT a hotspot link falls back to the anonymous path
// (their name is pre-filled) so they can still report — never a dead end.
// Anonymous reporter name/dept is cached per phone for 30 days.
// =============================================================================

import type { AppUser } from '@prisma/client';
import {
  REDIS_KEYS,
  WA_CONV_TTL_SEC,
  type TicketCategory,
  type WaConvState,
} from '@noc/shared';
import type { Redis } from '@noc/server';
import { createAndForwardTicket, type BotCtx } from './tickets';
import { card } from './fmt';

const IDENT_TTL_SEC = 30 * 24 * 3600;

export async function getConv(redis: Redis, phone: string): Promise<WaConvState | null> {
  const raw = await redis.get(REDIS_KEYS.waConv(phone));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WaConvState;
  } catch {
    return null;
  }
}

async function setConv(redis: Redis, phone: string, s: WaConvState): Promise<void> {
  await redis.set(REDIS_KEYS.waConv(phone), JSON.stringify(s), 'EX', WA_CONV_TTL_SEC);
}

async function clearConv(redis: Redis, phone: string): Promise<void> {
  await redis.del(REDIS_KEYS.waConv(phone));
}

interface WaIdent { name?: string; dept?: string }

async function getIdent(redis: Redis, phone: string): Promise<WaIdent | null> {
  const raw = await redis.get(REDIS_KEYS.waIdent(phone)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as WaIdent; } catch { return null; }
}

async function setIdent(redis: Redis, phone: string, id: WaIdent): Promise<void> {
  await redis.set(REDIS_KEYS.waIdent(phone), JSON.stringify(id), 'EX', IDENT_TTL_SEC).catch(() => undefined);
}

/** Rough complaint category from free text — mirrors the web form's options. */
export function detectCategory(text: string): TicketCategory {
  const t = text.toLowerCase();
  if (/voucher|top.?up|isi ulang|bayar|beli|harga|tagihan/.test(t)) return 'voucher';
  if (/lambat|lemot|lag|loading|buffering|lemoat/.test(t)) return 'lambat';
  return 'gangguan';
}

const BATAL_HINT = 'Ketik BATAL untuk batal · 0 untuk kembali';

async function sitePickStep(ctx: BotCtx, phone: string, conv: WaConvState, stepLabel: string): Promise<void> {
  const sites = await ctx.prisma.site.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 20,
  });
  if (sites.length === 0) {
    await clearConv(ctx.redis, phone);
    await ctx.reply(phone, card('⚠️ *Belum ada site*', 'Belum ada site terdaftar — hubungi admin.'));
    return;
  }
  await setConv(ctx.redis, phone, { ...conv, step: 'site', siteIds: sites.map((s) => s.id) });
  await ctx.reply(
    phone,
    card(
      stepLabel,
      `${conv.flow === 'register' ? 'Permintaan akun' : 'Komplain'} untuk site mana?\n` +
        sites.map((s, i) => `*${i + 1}.* ${s.name}`).join('\n'),
      'Balas dengan nomor · ' + BATAL_HINT,
    ),
  );
}

/** `komplain [teks]` — member inline/wizard, or anonymous wizard w/ ident cache. */
export async function startComplaint(
  ctx: BotCtx,
  phone: string,
  inlineText: string,
  user: AppUser | null,
): Promise<void> {
  const base: WaConvState = { flow: 'complaint', step: 'name', message: inlineText || undefined };
  if (user?.role === 'member') {
    // Member's site comes from their hotspot router — no asking needed.
    const router = user.hotspotRouterId
      ? await ctx.prisma.routerMikrotik.findUnique({ where: { id: user.hotspotRouterId } })
      : null;
    const siteId = router?.siteId ?? null;
    if (!siteId) {
      // Linked but no hotspot link — fall back to the anonymous wizard so the
      // user can still report instead of hitting a dead end.
      await startAnonymous(ctx, phone, { name: user.name, dept: user.department ?? undefined }, inlineText);
      return;
    }
    // Department is asked exactly once, then lives on the member profile.
    if (!user.department) {
      await setConv(ctx.redis, phone, { ...base, step: 'dept', memberId: user.id, siteId, name: user.name });
      await ctx.reply(
        phone,
        card('📝 *Komplain — langkah terakhir*', 'Anda dari departemen/bagian apa?\n_(ditanya sekali saja)_', BATAL_HINT),
      );
      return;
    }
    if (inlineText) {
      const { t, targets } = await createAndForwardTicket(ctx, {
        siteId,
        reporterPhone: phone,
        reporterName: user.name,
        reporterDept: user.department,
        memberId: user.id,
        category: detectCategory(inlineText),
        message: inlineText,
      });
      await ctx.reply(phone, ticketSentCard(t.id, targets));
      return;
    }
    await setConv(ctx.redis, phone, { ...base, step: 'message', memberId: user.id, siteId, dept: user.department });
    await ctx.reply(phone, card('📝 *Tulis komplain Anda*', 'Jelaskan gangguannya — bisa panjang.', BATAL_HINT));
    return;
  }
  // Verified staff (non-member): same anonymous wizard, but pre-fill name/dept
  // from the account so they don't retype it on every complaint.
  const ident = await getIdent(ctx.redis, phone);
  const pref: WaIdent | null = user
    ? { name: user.name, dept: user.department ?? ident?.dept }
    : ident;
  await startAnonymous(ctx, phone, pref, inlineText);
}

async function startAnonymous(ctx: BotCtx, phone: string, ident: WaIdent | null, inlineText: string): Promise<void> {
  const base: WaConvState = { flow: 'complaint', step: 'name', name: ident?.name, dept: ident?.dept, message: inlineText || undefined };
  if (ident?.name && ident?.dept) return sitePickStep(ctx, phone, base, '📝 *Lapor Gangguan — pilih site*');
  if (ident?.name) {
    await setConv(ctx.redis, phone, { ...base, step: 'dept' });
    await ctx.reply(phone, card('📝 *Lapor Gangguan — langkah 2/4*', `Halo lagi, *${ident.name}*! 👋\nDepartemen/bagian apa? _(mis. Produksi, QC)_`, BATAL_HINT));
    return;
  }
  await setConv(ctx.redis, phone, { ...base, step: 'name' });
  await ctx.reply(phone, card('📝 *Lapor Gangguan — langkah 1/4*', 'Baik, kami bantu catat.\n*Siapa nama Anda?*', BATAL_HINT));
}

/** `daftar` — account-request wizard for brand-new users (3 steps). */
export async function startRegister(ctx: BotCtx, phone: string): Promise<void> {
  const ident = await getIdent(ctx.redis, phone);
  const base: WaConvState = { flow: 'register', step: 'name', name: ident?.name, dept: ident?.dept };
  if (ident?.name && ident?.dept) return sitePickStep(ctx, phone, base, '🆕 *Permintaan Akun — pilih site*');
  if (ident?.name) {
    await setConv(ctx.redis, phone, { ...base, step: 'dept' });
    await ctx.reply(phone, card('🆕 *Permintaan Akun — langkah 2/3*', `Halo *${ident.name}*!\nDepartemen/bagian apa?`, BATAL_HINT));
    return;
  }
  await setConv(ctx.redis, phone, { ...base, step: 'name' });
  await ctx.reply(
    phone,
    card('🆕 *Permintaan Akun — langkah 1/3*', 'Kami buatkan permintaan akun untuk admin.\n*Siapa nama Anda?*', BATAL_HINT),
  );
}

function ticketSentCard(ticketId: string, targets: number): string {
  const code = ticketId.slice(0, 6).toUpperCase();
  if (targets > 0) {
    return card(
      '✅ *Terkirim*',
      `Tiket *#${code}* sudah diteruskan ke *${targets}* kontak teknisi.\nKami kabari begitu ada update.`,
      'Ketik TIKET untuk cek status',
    );
  }
  return card(
    '✅ *Tercatat*',
    `Tiket *#${code}* tersimpan dan dipantau via dashboard NOC.\n_(Kontak WA teknisi site ini belum diset admin)_`,
    'Ketik TIKET untuk cek status',
  );
}

/** Previous step for 0/KEMBALI — null when already at the first step. */
function prevStep(conv: WaConvState): WaConvState['step'] | null {
  if (conv.flow === 'register' || !conv.memberId) {
    const back: Partial<Record<WaConvState['step'], WaConvState['step']>> = {
      dept: 'name',
      site: 'dept',
      message: 'site',
    };
    return back[conv.step] ?? null;
  }
  // Member flow: dept is only asked when it's the first step; message may go back to dept.
  if (conv.step === 'message' && !conv.dept) return 'dept';
  return null;
}

const EXIT = /^(batal|menu|keluar)$/i;
const BACK = /^(0|kembali)$/i;

/** Continue a pending intake conversation. */
export async function continueIntake(
  ctx: BotCtx,
  phone: string,
  text: string,
  conv: WaConvState,
): Promise<void> {
  const label = conv.flow === 'register' ? 'Permintaan akun' : 'Komplain';
  if (EXIT.test(text.trim())) {
    await clearConv(ctx.redis, phone);
    await ctx.reply(phone, card('🚫 *Dibatalkan*', `${label} dibatalkan — tidak ada yang tercatat.`, 'Ketik MENU untuk daftar perintah'));
    return;
  }
  if (BACK.test(text.trim())) {
    const prev = prevStep(conv);
    if (!prev) {
      await ctx.reply(phone, card('ℹ️ *Langkah awal*', 'Sudah di langkah pertama.', BATAL_HINT));
      return;
    }
    const next: WaConvState = { ...conv, step: prev };
    if (prev === 'name') next.name = undefined;
    if (prev === 'dept') next.dept = undefined;
    await setConv(ctx.redis, phone, next);
    await askStep(ctx, phone, next);
    return;
  }

  const tag = conv.flow === 'register' ? '🆕 *Permintaan Akun' : '📝 *Lapor Gangguan';

  if (conv.step === 'name') {
    const name = text.trim().slice(0, 80);
    if (name.length < 2) {
      await ctx.reply(phone, card('❓ *Terlalu pendek*', 'Nama terlalu pendek — coba lagi.', BATAL_HINT));
      return;
    }
    await setConv(ctx.redis, phone, { ...conv, step: 'dept', name });
    await ctx.reply(phone, card(`${tag} — langkah 2*`, `Halo *${name}*! 👋\nDepartemen/bagian apa? _(mis. Produksi, QC)_`, BATAL_HINT));
    return;
  }

  if (conv.step === 'dept') {
    const dept = text.trim().slice(0, 80);
    if (dept.length < 2) {
      await ctx.reply(phone, card('❓ *Terlalu pendek*', 'Departemen terlalu pendek — coba lagi.', BATAL_HINT));
      return;
    }
    // Linked member: persist once on the profile so we never ask again.
    if (conv.memberId) {
      await ctx.prisma.appUser
        .update({ where: { id: conv.memberId }, data: { department: dept } })
        .catch(() => undefined);
      // Member who passed `komplain <teks>` inline already gave the body.
      if (conv.message && conv.siteId) {
        await clearConv(ctx.redis, phone);
        const { t, targets } = await createAndForwardTicket(ctx, {
          siteId: conv.siteId,
          reporterPhone: phone,
          reporterName: conv.name ?? null,
          reporterDept: dept,
          memberId: conv.memberId,
          category: detectCategory(conv.message),
          message: conv.message,
        });
        await ctx.reply(phone, ticketSentCard(t.id, targets));
        return;
      }
      const next: WaConvState = { ...conv, step: 'message', dept };
      await setConv(ctx.redis, phone, next);
      await ctx.reply(phone, card('📝 *Tulis komplain Anda*', 'Jelaskan gangguannya — bisa panjang.', BATAL_HINT));
      return;
    }
    // Anonymous → site pick (complaint AND register share this step).
    await sitePickStep(
      ctx, phone, { ...conv, dept },
      `${tag} — langkah ${conv.flow === 'register' ? '3*' : '3*'}`,
    );
    return;
  }

  if (conv.step === 'site') {
    const siteIds = conv.siteIds ?? [];
    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < 1 || n > siteIds.length) {
      await ctx.reply(phone, card('❓ *Pilihan tidak ada*', `Balas dengan nomor *1–${siteIds.length}*.`, BATAL_HINT));
      return;
    }
    const siteId = siteIds[n - 1]!;

    if (conv.flow === 'register') {
      await clearConv(ctx.redis, phone);
      await setIdent(ctx.redis, phone, { name: conv.name, dept: conv.dept });
      const message =
        `PERMINTAAN AKUN BARU\n` +
        `Nama       : ${conv.name ?? '-'}\n` +
        `Departemen : ${conv.dept ?? '-'}\n` +
        `No. WA     : ${phone}`;
      const { t, targets } = await createAndForwardTicket(ctx, {
        siteId,
        reporterPhone: phone,
        reporterName: conv.name ?? null,
        reporterDept: conv.dept ?? null,
        category: 'lainnya',
        message,
      });
      await ctx.reply(
        phone,
        targets > 0
          ? card('✅ *Permintaan terkirim*', `Tiket *#${t.id.slice(0, 6).toUpperCase()}* sudah diteruskan ke admin.\nSetelah akun dibuat, Anda akan dihubungi — lalu tautkan nomor ini dengan *LINK <kode>*.`)
          : card('✅ *Permintaan tercatat*', `Tiket *#${t.id.slice(0, 6).toUpperCase()}* tersimpan — admin akan menindaklanjuti via dashboard.`),
      );
      return;
    }

    await setConv(ctx.redis, phone, { ...conv, step: 'message', siteId });
    await ctx.reply(phone, card('📝 *Lapor Gangguan — langkah 4/4*', 'Tulis komplain Anda — bisa panjang.', BATAL_HINT));
    return;
  }

  // step === 'message' (complaint only)
  if (!conv.siteId) {
    await clearConv(ctx.redis, phone);
    await ctx.reply(phone, card('⏰ *Sesi kedaluwarsa*', 'Sesi komplain kedaluwarsa.\nKetik *KOMPLAIN* untuk mulai ulang.'));
    return;
  }
  const message = text.trim().slice(0, 1000);
  if (message.length < 5) {
    await ctx.reply(phone, card('❓ *Terlalu pendek*', 'Jelaskan sedikit lebih detail agar teknisi paham.', BATAL_HINT));
    return;
  }
  await clearConv(ctx.redis, phone);
  if (!conv.memberId) await setIdent(ctx.redis, phone, { name: conv.name, dept: conv.dept });
  const { t, targets } = await createAndForwardTicket(ctx, {
    siteId: conv.siteId,
    reporterPhone: phone,
    reporterName: conv.name ?? null,
    reporterDept: conv.dept ?? null,
    memberId: conv.memberId ?? null,
    category: detectCategory(message),
    message,
  });
  await ctx.reply(phone, ticketSentCard(t.id, targets));
}

/** Re-ask the current step (used by back-nav). */
async function askStep(ctx: BotCtx, phone: string, conv: WaConvState): Promise<void> {
  const tag = conv.flow === 'register' ? '🆕 *Permintaan Akun' : '📝 *Lapor Gangguan';
  if (conv.step === 'name') {
    await ctx.reply(phone, card(`${tag} — langkah 1*`, 'Siapa nama Anda?', BATAL_HINT));
  } else if (conv.step === 'dept') {
    await ctx.reply(phone, card(`${tag} — langkah 2*`, 'Departemen/bagian apa?', BATAL_HINT));
  } else if (conv.step === 'site' && conv.siteIds?.length) {
    const sites = await ctx.prisma.site.findMany({ where: { id: { in: conv.siteIds } }, orderBy: { name: 'asc' } });
    const ordered = conv.siteIds.map((id, i) => `${i + 1}. ${sites.find((s) => s.id === id)?.name ?? id}`).join('\n');
    await ctx.reply(phone, card(`${tag} — pilih site*`, ordered, 'Balas dengan nomor · ' + BATAL_HINT));
  } else {
    await ctx.reply(phone, card('📝 *Tulis komplain Anda*', 'Jelaskan gangguannya — bisa panjang.', BATAL_HINT));
  }
}
