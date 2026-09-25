import { hashPassword, prisma } from '@noc/server';

/**
 * Provision the member (self-service) account for a hotspot user just created
 * on a router. The member logs into the NOC with the hotspot username (stored
 * in AppUser.email — the login id) and the same password as the hotspot account.
 * Idempotent: an existing login id is left untouched and reported as 'exists'.
 *
 * The hotspot password is REQUIRED — never fall back to password=username (a
 * trivially guessable credential). Passwordless router users (e.g. MAC-bind or
 * trial entries seen by sync-portal) are reported as 'no-password' and skipped.
 */
export async function provisionMember(
  routerId: string,
  hs: { name: string; password?: string; comment?: string },
): Promise<'created' | 'exists' | 'no-password' | 'error'> {
  if (!hs.password) return 'no-password';
  try {
    const exists = await prisma.appUser.findUnique({ where: { email: hs.name } });
    if (exists) return 'exists';
    await prisma.appUser.create({
      data: {
        name: hs.comment?.trim() || hs.name,
        email: hs.name,
        passwordHash: await hashPassword(hs.password),
        role: 'member',
        scopeSiteIds: [],
        isActive: true,
        hotspotRouterId: routerId,
        hotspotUsername: hs.name,
      },
    });
    return 'created';
  } catch {
    return 'error';
  }
}

/** Re-hash a member's app password when the hotspot password was changed by an
 * admin, so the two credentials never drift apart. */
export async function syncMemberPassword(
  routerId: string,
  hotspotUsername: string,
  newPassword: string,
): Promise<void> {
  await prisma.appUser.updateMany({
    where: { hotspotRouterId: routerId, hotspotUsername },
    data: { passwordHash: await hashPassword(newPassword) },
  });
}
