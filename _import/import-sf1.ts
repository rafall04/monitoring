import { readFileSync } from 'node:fs';
import { prisma } from '@noc/server';

const DRY = process.env.DRY_RUN === '1';
const TAG = 'import:sf1-pdf-2026-06-29';

interface Dev { name: string; ip: string; type: string; line: string | null; orderIndex: number }
interface Area { name: string; kind: string; lines: string[]; devices: Dev[] }

async function main() {
  const path = process.argv[2] ?? './import-data.json';
  const data = JSON.parse(readFileSync(path, 'utf8')) as { areas: Area[] };

  const site = await prisma.site.findFirst({ where: { name: 'SF 1' } });
  if (!site) throw new Error('Site "SF 1" not found');
  const router = await prisma.routerMikrotik.findFirst({ where: { siteId: site.id } });
  if (!router) throw new Error('No router for site SF 1');
  console.log(`Site=${site.id}  Router=${router.id} (${router.host})  DRY_RUN=${DRY}`);

  let cA = 0, cL = 0, cD = 0, skip = 0;
  let areaOrder = await prisma.area.count({ where: { siteId: site.id } });

  for (const a of data.areas) {
    let area = await prisma.area.findFirst({ where: { siteId: site.id, name: a.name } });
    if (!area) {
      cA++;
      if (DRY) { console.log(`+ AREA "${a.name}" [${a.kind}]`); area = { id: `DRY:${a.name}` } as any; }
      else area = await prisma.area.create({ data: { siteId: site.id, name: a.name, kind: a.kind, orderIndex: areaOrder++ } });
    } else {
      console.log(`= AREA "${a.name}" exists (${area.id})`);
    }

    const lineId: Record<string, string> = {};
    let li = 0;
    for (const ln of a.lines) {
      let line = await prisma.line.findFirst({ where: { areaId: area!.id, name: ln } });
      if (!line) {
        cL++;
        if (DRY) { console.log(`  + LINE "${ln}"`); line = { id: `DRY:${ln}` } as any; }
        else line = await prisma.line.create({ data: { areaId: area!.id, name: ln, orderIndex: li } });
      }
      lineId[ln] = line!.id;
      li++;
    }

    for (const d of a.devices) {
      const exists = await prisma.device.findFirst({ where: { siteId: site.id, ipAddress: d.ip } });
      if (exists) { skip++; console.log(`  ~ SKIP ${d.ip} (exists: "${exists.name}")`); continue; }
      cD++;
      if (DRY) { console.log(`    + DEV "${d.name}" ${d.ip} ${d.type} line=${d.line ?? '-'}`); continue; }
      await prisma.device.create({
        data: {
          routerId: router.id,
          siteId: site.id,
          areaId: area!.id,
          lineId: d.line ? lineId[d.line] : null,
          name: d.name,
          ipAddress: d.ip,
          type: d.type,
          orderIndex: d.orderIndex,
          note: TAG,
        },
      });
    }
  }
  console.log(`\nRESULT  areas+${cA}  lines+${cL}  devices+${cD}  skipped=${skip}  (DRY_RUN=${DRY})`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('IMPORT FAILED:', e); process.exit(1); });
