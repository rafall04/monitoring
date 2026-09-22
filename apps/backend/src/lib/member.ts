import bcrypt from 'bcryptjs';
import { prisma } from '@noc/server';

/**
 * Provision the member (self-service) account for a hotspot user just created
 * on a router. The member logs into the NOC with the hotspot username (stored
 * in AppUser.email — the login id) and the same password as the hotspot account.
 * Idempotent: an existing login id is left untouched and reported as 'exists'.
 */
export async function provisionMember(
  routerId: string,
  hs: { name: string; password?: string; comment?: string },
): Promise<'created' | 'exists' | 'error'> {
  try {
    const exists = await prisma.appUser.findUnique({ where: { email: hs.name } });
    if (exists) return 'exists';
    await prisma.appUser.create({
      data: {
        name: hs.comment?.trim() || hs.name,
        email: hs.name,
        passwordHash: await bcrypt.hash(hs.password || hs.name, 10),
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
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });
}
