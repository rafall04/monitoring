import type { FastifyInstance } from 'fastify';
import { alertRoutes } from './alerts';
import { auditRoutes } from './audit';
import { authRoutes } from './auth';
import { companyRoutes } from './companies';
import { deviceRoutes } from './devices';
import { firewallRoutes } from './firewall';
import { hotspotRoutes } from './hotspot';
import { reportRoutes } from './reports';
import { routerRoutes } from './routers';
import { ruijieRoutes } from './ruijie';
import { settingsRoutes } from './settings';
import { siteRoutes } from './sites';
import { topologyRoutes } from './topology';
import { uploadRoutes } from './uploads';
import { userRoutes } from './users';
import { webhookRoutes } from './webhook';

export async function apiRoutes(app: FastifyInstance) {
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(companyRoutes, { prefix: '/companies' });
  await app.register(siteRoutes, { prefix: '/sites' });
  await app.register(routerRoutes, { prefix: '/routers' });
  await app.register(deviceRoutes, { prefix: '/devices' });
  await app.register(topologyRoutes);
  await app.register(hotspotRoutes, { prefix: '/hotspot' });
  await app.register(firewallRoutes, { prefix: '/firewall' });
  await app.register(reportRoutes, { prefix: '/reports' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(settingsRoutes, { prefix: '/settings' });
  await app.register(alertRoutes, { prefix: '/alerts' });
  await app.register(auditRoutes, { prefix: '/audit' });
  await app.register(ruijieRoutes, { prefix: '/ruijie' });
  await app.register(uploadRoutes, { prefix: '/uploads' });
  await app.register(webhookRoutes, { prefix: '/webhook' });
}
