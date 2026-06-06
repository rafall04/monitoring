import type { FastifyInstance } from 'fastify';
import { getSettings, toBrandingPublic, updateSettings } from '@noc/server';
import { updateSettingsSchema } from '@noc/shared';
import { badRequest } from '../lib/errors';
import { saveUpload } from '../lib/uploads';
import { writeAudit } from '../lib/audit';
import { authenticate, requirePermission } from '../plugins/rbac';

/**
 * Settings + branding. The /branding endpoint is intentionally PUBLIC so the
 * login page (and any unauthenticated screen) can render the org name, logo and
 * accent color before the user signs in. Everything else is gated to
 * `settings:manage` (super_admin).
 */
export async function settingsRoutes(app: FastifyInstance) {
  // Public branding — no auth. Reads the singleton, lazy-creates if missing.
  app.get('/branding', async () => toBrandingPublic(await getSettings()));

  const guard = { onRequest: [authenticate], preHandler: [requirePermission('settings:manage')] };

  app.get('/', guard, async () => {
    const s = await getSettings();
    return { ...s, updatedAt: s.updatedAt.toISOString() };
  });

  app.patch('/', guard, async (req) => {
    const body = updateSettingsSchema.parse(req.body);
    const before = await getSettings();
    const s = await updateSettings(body);
    await writeAudit(req, {
      action: 'update',
      entity: 'setting',
      entityId: s.id,
      before,
      after: s,
    });
    return { ...s, updatedAt: s.updatedAt.toISOString() };
  });

  // Logo upload — stores the file and writes its URL into the singleton.
  app.post('/logo', guard, async (req) => {
    const part = await req.file();
    if (!part) throw badRequest('No file uploaded');
    const { url } = await saveUpload(part, 'logo');
    const s = await updateSettings({ logoUrl: url });
    await writeAudit(req, { action: 'update-logo', entity: 'setting', entityId: s.id, after: { logoUrl: url } });
    return { logoUrl: url };
  });
}
