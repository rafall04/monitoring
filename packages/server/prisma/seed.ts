// =============================================================================
// Seed: first super_admin (from env) + demo data (company/sites/routers/devices)
// + demo operator & viewer accounts so RBAC can be tried immediately.
// Safe to re-run: the super_admin is upserted; demo data is created only once.
// =============================================================================

import bcrypt from 'bcryptjs';
import { prisma } from '../src/db';
import { encryptSecret, generateToken } from '../src/crypto';

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL ?? 'admin@noc.local';
  const password = process.env.SUPER_ADMIN_PASSWORD ?? 'ChangeMe123!';
  const name = process.env.SUPER_ADMIN_NAME ?? 'Super Admin';

  const admin = await prisma.appUser.upsert({
    where: { email },
    update: { role: 'super_admin', isActive: true },
    create: {
      name,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role: 'super_admin',
      scopeSiteIds: [],
      isActive: true,
    },
  });
  console.log(`✓ super_admin ready: ${admin.email}`);

  // Demo data (Demo Corp + sample sites/routers/devices) is OPT-IN so production
  // deploys start with a clean database. Enable with SEED_DEMO=true.
  if (process.env.SEED_DEMO !== 'true') {
    console.log('• SEED_DEMO not set — skipping demo data (clean start)');
    return;
  }

  const existing = await prisma.company.count();
  if (existing > 0) {
    console.log('• demo data already present, skipping');
    return;
  }

  const company = await prisma.company.create({ data: { name: 'Demo Corp' } });

  // --- Site A: factory floorplan (CRS.Simple) ---
  const siteA = await prisma.site.create({
    data: {
      companyId: company.id,
      name: 'HQ Factory',
      mapMode: 'floorplan',
      floorplanImageUrl: '/sample-floorplan.svg',
      floorplanWidth: 1600,
      floorplanHeight: 1000,
      imageBounds: [
        [0, 0],
        [1000, 1600],
      ],
      defaultZoom: 0,
    },
  });

  // --- Site B: branch office (geo / OSM) ---
  const siteB = await prisma.site.create({
    data: {
      companyId: company.id,
      name: 'Branch Office',
      mapMode: 'geo',
      geoCenterLat: -6.2,
      geoCenterLng: 106.8,
      defaultZoom: 16,
    },
  });

  const routerA = await prisma.routerMikrotik.create({
    data: {
      siteId: siteA.id,
      name: 'RB-HQ',
      host: '192.168.88.1',
      apiPort: 8728,
      useTls: false,
      username: 'noc',
      passwordEncrypted: encryptSecret('demo-password'),
      routerosVersion: 'v6',
      webhookToken: generateToken(),
      status: 'online',
      lastSeenAt: new Date(),
    },
  });

  const routerB = await prisma.routerMikrotik.create({
    data: {
      siteId: siteB.id,
      name: 'RB-Branch',
      host: '10.10.0.1',
      apiPort: 8728,
      useTls: false,
      username: 'noc',
      passwordEncrypted: encryptSecret('demo-password'),
      routerosVersion: 'v6',
      webhookToken: generateToken(),
      status: 'online',
      lastSeenAt: new Date(),
    },
  });

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const now = new Date();

  await prisma.device.createMany({
    data: [
      // Site A (floorplan: mapX in 0..1600, mapY in 0..1000)
      { routerId: routerA.id, siteId: siteA.id, name: 'Core Router', ipAddress: '192.168.88.1', type: 'router', iconKey: 'router', mapX: 800, mapY: 500, status: 'up', statusSince: now, isCritical: true },
      { routerId: routerA.id, siteId: siteA.id, name: 'Switch Floor 1', ipAddress: '192.168.88.2', type: 'switch', iconKey: 'switch', mapX: 400, mapY: 300, status: 'up', statusSince: now },
      { routerId: routerA.id, siteId: siteA.id, name: 'AP Lobby', ipAddress: '192.168.88.10', type: 'access_point', iconKey: 'access_point', mapX: 300, mapY: 720, status: 'down', statusSince: oneHourAgo },
      { routerId: routerA.id, siteId: siteA.id, name: 'CCTV Gate', ipAddress: '192.168.88.20', type: 'cctv', iconKey: 'cctv', mapX: 1200, mapY: 200, status: 'up', statusSince: now, isCritical: true },
      { routerId: routerA.id, siteId: siteA.id, name: 'NVR Server', ipAddress: '192.168.88.30', type: 'server', iconKey: 'server', mapX: 1320, mapY: 820, status: 'up', statusSince: now },
      { routerId: routerA.id, siteId: siteA.id, name: 'Office Printer', ipAddress: '192.168.88.40', type: 'printer', iconKey: 'printer', mapX: 620, mapY: 860, status: 'unknown' },
      // Site B (geo)
      { routerId: routerB.id, siteId: siteB.id, name: 'Branch Router', ipAddress: '10.10.0.1', type: 'router', iconKey: 'router', geoLat: -6.2, geoLng: 106.8, status: 'up', statusSince: now, isCritical: true },
      { routerId: routerB.id, siteId: siteB.id, name: 'Branch AP', ipAddress: '10.10.0.10', type: 'access_point', iconKey: 'access_point', geoLat: -6.2012, geoLng: 106.8015, status: 'up', statusSince: now },
      { routerId: routerB.id, siteId: siteB.id, name: 'Branch CCTV', ipAddress: '10.10.0.20', type: 'cctv', iconKey: 'cctv', geoLat: -6.1995, geoLng: 106.799, status: 'down', statusSince: oneHourAgo },
    ],
  });

  // demo operator (scoped to Site A) + viewer (scoped to Site B)
  await prisma.appUser.create({
    data: {
      name: 'Demo Operator',
      email: 'operator@noc.local',
      passwordHash: await bcrypt.hash('Operator123!', 10),
      role: 'operator',
      scopeSiteIds: [siteA.id],
      isActive: true,
    },
  });
  await prisma.appUser.create({
    data: {
      name: 'Demo Viewer',
      email: 'viewer@noc.local',
      passwordHash: await bcrypt.hash('Viewer123!', 10),
      role: 'user',
      scopeSiteIds: [siteB.id],
      isActive: true,
    },
  });

  console.log('✓ demo data created:');
  console.log(`  company: ${company.name}`);
  console.log(`  sites:   ${siteA.name} (floorplan), ${siteB.name} (geo)`);
  console.log('  logins:  operator@noc.local / Operator123!,  viewer@noc.local / Viewer123!');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
