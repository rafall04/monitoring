import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors';
import { saveUpload } from '../lib/uploads';
import { authenticate, requirePermission } from '../plugins/rbac';

export async function uploadRoutes(app: FastifyInstance) {
  // Custom device icon upload (PNG/WebP/JPEG/SVG, SVG sanitised).
  app.post(
    '/icon',
    { onRequest: [authenticate], preHandler: [requirePermission('device:edit-attributes')] },
    async (req) => {
      const part = await req.file();
      if (!part) throw badRequest('No file uploaded');
      const { url } = await saveUpload(part, 'icon');
      return { url };
    },
  );
}
