// =============================================================================
// Complaint intake — a small state machine per phone number in Redis
// (noc:wa:conv:<phone>, JSON + TTL). Entry shapes:
//   - linked member WITH dept on profile: `komplain` → next message is the body
//   - linked member WITHOUT dept:         `komplain` → dept (saved once) → body
//   - anonymous:                          `komplain` → name → dept → site → body
// `batal` exits the flow from any step.
// =============================================================================

import type { AppUser } from '@prisma/client';
import { REDIS_KEYS, WA_CONV_TTL_SEC, type WaConvState } from '@noc/shared';
import type { Redis } from '@noc/server';
import { createAndForwardTicket, type BotCtx } from './tickets';
import { card } from './fmt';

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

/** `komplain [teks]` — linked member may pass the body inline; otherwise wizard. */
export async function startComplaint(
  ctx: BotCtx,
  phone: string,
  inlineText: string,
  user: AppUser | null,
): Promise<void> {
  if (user) {
    // Member's site comes from their hotspot router — no asking needed.
    const router = user.hotspotRouterId
      ? await ctx.prisma.routerMikrotik.findUnique({ where: { id: user.hotspotRouterId } })
      : null;
    const siteId = router?.siteId ?? null;
    if (!siteId) {
      await ctx.reply(phone, card('⚠️ *Akun belum lengkap*', 'Akun Anda belum tertaut ke site manapun — hubungi admin.'));
      return;
    }
    // Department is asked exactly once, then lives on the member profile.
    if (!user.department) {
      await setConv(ctx.redis, phone, {
        flow: 'complaint',
        step: 'dept',
        memberId: user.id,
        siteId,
        name: user.name,
        message: inlineText || undefined,
      });
      await ctx.reply(
        phone,
        card('📝 *Komplain — langkah terakhir*', 'Anda dari departemen/bagian apa?\n_(ditanya sekali saja)_', 'Ketik BATAL untuk membatalkan'),
      );
      return;
    }
    if (inlineText) {
      const t = await createAndForwardTicket(ctx, {
        siteId,
        reporterPhone: phone,
        reporterName: user.name,
        reporterDept: user.department,
        memberId: user.id,
        message: inlineText,
      });
      await ctx.reply(phone, card('✅ *Komplain terkirim*', `Tiket *#${t.id.slice(0, 6).toUpperCase()}* sudah diteruskan ke teknisi.\nKami kabari begitu ada update.`));
      return;
    }
    await setConv(ctx.redis, phone, { flow: 'complaint', step: 'message', memberId: user.id, siteId, dept: user.department });
    await ctx.reply(phone, card('📝 *Tulis komplain Anda*', 'Jelaskan gangguannya — bisa panjang.', 'Ketik BATAL untuk membatalkan'));
    return;
  }

  await setConv(ctx.redis, phone, { flow: 'complaint', step: 'name' });
  await ctx.reply(phone, card('📝 *Lapor Gangguan — langkah 1/4*', 'Baik, kami bantu catat.\n*Siapa nama Anda?*', 'Ketik BATAL untuk membatalkan'));
}

/** Continue a pending intake conversation. */
export async function continueIntake(
  ctx: BotCtx,
  phone: string,
  text: string,
  conv: WaConvState,
): Promise<void> {
  if (/^batal$/i.test(text.trim())) {
    await clearConv(ctx.redis, phone);
    await ctx.reply(phone, card('🚫 *Dibatalkan*', 'Komplain dibatalkan — tidak ada yang tercatat.'));
    return;
  }

  if (conv.step === 'name') {
    const name = text.trim().slice(0, 80);
    if (name.length < 2) {
      await ctx.reply(phone, card('❓ *Terlalu pendek*', 'Nama terlalu pendek — coba lagi.'));
      return;
    }
    await setConv(ctx.redis, phone, { ...conv, step: 'dept', name });
    await ctx.reply(phone, card('📝 *Lapor Gangguan — langkah 2/4*', `Halo *${name}*! 👋\nDepartemen/bagian apa? _(mis. Produksi, QC, Office)_`));
    return;
  }

  if (conv.step === 'dept') {
    const dept = text.trim().slice(0, 80);
    if (dept.length < 2) {
      await ctx.reply(phone, card('❓ *Terlalu pendek*', 'Departemen terlalu pendek — coba lagi.'));
      return;
    }
    // Linked member: persist once on the profile so we never ask again.
    if (conv.memberId) {
      await ctx.prisma.appUser
        .update({ where: { id: conv.memberId }, data: { department: dept } })
        .catch(() => undefined);
    }
    // Member who passed `komplain <teks>` inline already gave the body — done.
    if (conv.memberId && conv.message && conv.siteId) {
      await clearConv(ctx.redis, phone);
      const t = await createAndForwardTicket(ctx, {
        siteId: conv.siteId,
        reporterPhone: phone,
        reporterName: conv.name ?? null,
        reporterDept: dept,
        memberId: conv.memberId,
        message: conv.message,
      });
      await ctx.reply(phone, card('✅ *Komplain terkirim*', `Tiket *#${t.id.slice(0, 6).toUpperCase()}* sudah diteruskan ke teknisi.\nKami kabari begitu ada update.`));
      return;
    }
    const next: WaConvState = { ...conv, step: conv.memberId ? 'message' : 'site', dept };
    if (!conv.memberId) {
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
      next.siteIds = sites.map((s) => s.id);
      await setConv(ctx.redis, phone, next);
      await ctx.reply(
        phone,
        card(
          '📝 *Lapor Gangguan — langkah 3/4*',
          `Komplain untuk site mana?\n${sites.map((s, i) => `*${i + 1}.* ${s.name}`).join('\n')}`,
          'Balas dengan nomor',
        ),
      );
      return;
    }
    await setConv(ctx.redis, phone, next);
    await ctx.reply(phone, card('📝 *Langkah terakhir*', 'Tulis komplain Anda — bisa panjang.', 'Ketik BATAL untuk membatalkan'));
    return;
  }

  if (conv.step === 'site') {
    const siteIds = conv.siteIds ?? [];
    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < 1 || n > siteIds.length) {
      await ctx.reply(phone, card('❓ *Pilihan tidak ada*', `Balas dengan nomor *1–${siteIds.length}*.`));
      return;
    }
    await setConv(ctx.redis, phone, { ...conv, step: 'message', siteId: siteIds[n - 1] });
    await ctx.reply(phone, card('📝 *Lapor Gangguan — langkah 4/4*', 'Tulis komplain Anda — bisa panjang.', 'Ketik BATAL untuk membatalkan'));
    return;
  }

  // step === 'message'
  if (!conv.siteId) {
    await clearConv(ctx.redis, phone);
    await ctx.reply(phone, card('⏰ *Sesi kedaluwarsa*', 'Sesi komplain kedaluwarsa.\nKetik *KOMPLAIN* untuk mulai ulang.'));
    return;
  }
  const message = text.trim().slice(0, 1000);
  if (message.length < 5) {
    await ctx.reply(phone, card('❓ *Terlalu pendek*', 'Jelaskan sedikit lebih detail agar teknisi paham.'));
    return;
  }
  await clearConv(ctx.redis, phone);
  const t = await createAndForwardTicket(ctx, {
    siteId: conv.siteId,
    reporterPhone: phone,
    reporterName: conv.name ?? null,
    reporterDept: conv.dept ?? null,
    memberId: conv.memberId ?? null,
    message,
  });
  await ctx.reply(
    phone,
    card(
      '✅ *Komplain terkirim*',
      `Terima kasih, *${conv.name ?? 'Anda'}*!\nTiket *#${t.id.slice(0, 6).toUpperCase()}* sudah diteruskan ke teknisi.`,
      'Kami kabari begitu ada update',
    ),
  );
}
