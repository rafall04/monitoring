'use client';

import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  useNetInfo,
  usePing,
  usePoeCycle,
  useRouterLog,
  useRouters,
  useSiteDevices,
  useTraceroute,
} from '@/lib/queries';
import { useConfirm, useToast } from '@/lib/toast';
import {
  Badge,
  Button,
  Card,
  IconTile,
  Loading,
  Page,
  PageBody,
  PageHeader,
  SectionHeader,
  Select,
  TextInput,
} from '@/components/ui';

function Ic({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const PULSE = 'M3 12h4l2 5 4-13 2 8h6';
const NET = 'M5 12.55a11 11 0 0 1 14 0M8.5 16a6 6 0 0 1 7 0M12 20h.01M2 8.82a15 15 0 0 1 20 0';
const ROUTE = 'M6 3v12a3 3 0 0 0 3 3h6M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 3a3 3 0 1 0-.001-.001';
const LOG = 'M4 6h16M4 12h16M4 18h10';
const BOLT = 'M13 2 3 14h7l-1 8 10-12h-7z';

const isIp = (s: string) => /^[0-9a-fA-F:.]{3,45}$/.test(s.trim());

export default function DiagnosticsPage() {
  const { can } = useAuth();
  const routers = useRouters();
  const [rid, setRid] = useState<string | null>(null);
  const routerId = rid ?? routers.data?.[0]?.id ?? null;
  const router = routers.data?.find((r) => r.id === routerId) ?? null;
  const canRemediate = can('device:remediate');

  const devicesQ = useSiteDevices(router?.siteId);
  const devices = useMemo(
    () =>
      (devicesQ.data ?? [])
        .filter((d) => d.routerId === routerId && d.ipAddress)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [devicesQ.data, routerId],
  );

  const [ip, setIp] = useState('');
  const ping = usePing(routerId ?? '');
  const trace = useTraceroute(routerId ?? '');
  const netInfo = useNetInfo(routerId ?? '');
  const log = useRouterLog(routerId ?? '');
  const poe = usePoeCycle(routerId ?? '');
  const confirm = useConfirm();
  const toast = useToast();

  const valid = isIp(ip);
  const busy = ping.isPending || netInfo.isPending;

  function diagnose() {
    if (!valid) return;
    ping.mutate(ip);
    netInfo.mutate(ip);
    trace.reset();
  }

  async function powerCycle(port: string) {
    const ok = await confirm({
      title: 'Restart PoE port?',
      body: `Listrik port ${port} dimatikan lalu dihidupkan lagi (±5 detik). Device yang nyantol di port ini akan reboot. Lanjutkan?`,
      confirmLabel: 'Power-cycle',
      danger: true,
    });
    if (!ok) return;
    poe.mutate(port, {
      onSuccess: (res) =>
        res.backup === 'failed'
          ? toast.error(`Port ${port} di-power-cycle (backup gagal disimpan).`)
          : toast.ok(`Port ${port} di-power-cycle.`),
      onError: (e) => toast.error(`Gagal power-cycle: ${(e as Error).message}`),
    });
  }

  const p = ping.data;
  const pingTone = !p ? '' : p.lossPct >= 100 ? 'text-rose-400' : p.lossPct > 0 ? 'text-amber-400' : 'text-emerald-400';
  const ni = netInfo.data;

  return (
    <Page>
      <PageHeader
        title="Diagnostik"
        subtitle="Cek & perbaiki device dari sisi router: ping, traceroute, info jaringan, dan power-cycle PoE."
        actions={
          <Select value={routerId ?? ''} onChange={(e) => setRid(e.target.value)} className="w-full sm:w-64">
            {routers.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.host})
              </option>
            ))}
          </Select>
        }
      />
      <PageBody>
        {/* Target picker */}
        <Card className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Pilih device</span>
              <Select
                value=""
                onChange={(e) => e.target.value && setIp(e.target.value)}
                className="w-full"
              >
                <option value="">— device di router ini —</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.ipAddress ?? ''}>
                    {d.name} · {d.ipAddress}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">atau ketik IP</span>
              <TextInput
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="192.168.100.10"
                onKeyDown={(e) => e.key === 'Enter' && diagnose()}
              />
            </label>
            <Button onClick={diagnose} disabled={!valid || busy} className="w-full sm:w-auto">
              {busy ? 'Menjalankan…' : 'Diagnosa'}
            </Button>
          </div>
          {ip && !valid && <p className="mt-2 text-xs text-rose-400">Masukkan alamat IP yang valid.</p>}
        </Card>

        {/* Ping + net-info results */}
        {(ping.data || ping.isPending || netInfo.data || netInfo.isPending || ping.error) && (
          <section>
            <SectionHeader title="Hasil Diagnosa" icon={<Ic d={PULSE} />} tone="violet" />
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* Ping */}
              <Card className="p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <IconTile tone="violet"><Ic d={PULSE} /></IconTile> Ping dari router
                </div>
                {ping.isPending ? (
                  <Loading />
                ) : ping.error ? (
                  <p className="text-sm text-rose-400">{(ping.error as Error).message}</p>
                ) : p ? (
                  <div>
                    <div className={`text-2xl font-bold ${pingTone}`}>
                      {p.lossPct >= 100 ? 'Tidak merespons' : `${p.avgMs ?? '–'} ms`}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                      <span>terkirim {p.sent} · balas {p.received} · loss {p.lossPct}%</span>
                      {p.minMs != null && <span>min {p.minMs} / max {p.maxMs} ms</span>}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">—</p>
                )}
                <div className="mt-3">
                  <Button
                    variant="ghost"
                    onClick={() => valid && trace.mutate(ip)}
                    disabled={!valid || trace.isPending}
                    className="text-xs"
                  >
                    {trace.isPending ? 'Traceroute…' : 'Jalankan traceroute'}
                  </Button>
                </div>
              </Card>

              {/* Net info */}
              <Card className="p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <IconTile tone="sky"><Ic d={NET} /></IconTile> Info jaringan
                </div>
                {netInfo.isPending ? (
                  <Loading />
                ) : ni ? (
                  <dl className="space-y-1.5 text-sm">
                    <Row k="MAC" v={ni.arp?.macAddress || ni.lease?.macAddress || '—'} />
                    <Row k="Interface" v={ni.arp?.interface || '—'} />
                    <Row k="Hostname (DHCP)" v={ni.lease?.hostName || '—'} />
                    <Row
                      k="Lease"
                      v={ni.lease ? `${ni.lease.status ?? '—'}${ni.lease.expiresAfter ? ` · ${ni.lease.expiresAfter}` : ''}` : '—'}
                    />
                    {!ni.arp && !ni.lease && (
                      <p className="pt-1 text-xs text-amber-400">Tidak ada entri ARP/DHCP — device mungkin mati atau di luar jangkauan router ini.</p>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-slate-500">—</p>
                )}

                {/* PoE remediation */}
                {ni && (
                  <div className="mt-3 border-t border-surface-border pt-3">
                    {ni.poe ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-slate-400">
                          Port <span className="font-mono text-slate-200">{ni.poe.name}</span> · PoE{' '}
                          <Badge tone={ni.poe.status?.includes('on') ? 'emerald' : 'slate'}>{ni.poe.status ?? '?'}</Badge>
                          {ni.poe.power && <span className="ml-1">{ni.poe.power}</span>}
                        </div>
                        {canRemediate && (
                          <Button
                            variant="danger"
                            onClick={() => powerCycle(ni.poe!.name)}
                            disabled={poe.isPending}
                            className="text-xs"
                          >
                            <span className="mr-1 inline-block align-middle"><Ic d={BOLT} /></span>
                            {poe.isPending ? 'Memproses…' : 'Restart PoE'}
                          </Button>
                        )}
                      </div>
                    ) : ni.port ? (
                      <p className="text-xs text-slate-500">
                        Device di port <span className="font-mono">{ni.port}</span> — bukan port PoE router, power-cycle tidak tersedia (kemungkinan di balik switch).
                      </p>
                    ) : null}
                  </div>
                )}
              </Card>
            </div>

            {/* Traceroute */}
            {(trace.data || trace.isPending || trace.error) && (
              <Card className="mt-3 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <IconTile tone="amber"><Ic d={ROUTE} /></IconTile> Traceroute
                </div>
                {trace.isPending ? (
                  <Loading />
                ) : trace.error ? (
                  <p className="text-sm text-rose-400">{(trace.error as Error).message}</p>
                ) : trace.data && trace.data.length ? (
                  <div className="space-y-1 font-mono text-xs">
                    {trace.data.map((h) => (
                      <div key={h.hop} className="flex items-center gap-3">
                        <span className="w-6 text-slate-500">{h.hop}</span>
                        <span className="flex-1 text-slate-200">{h.address || '* (timeout)'}</span>
                        <span className="text-slate-400">{h.avgMs != null ? `${h.avgMs} ms` : ''}</span>
                        {h.lossPct != null && h.lossPct > 0 && <span className="text-amber-400">loss {h.lossPct}%</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Tidak ada hop.</p>
                )}
              </Card>
            )}
          </section>
        )}

        {/* Router log */}
        <section>
          <SectionHeader
            title="Log Router Terakhir"
            icon={<Ic d={LOG} />}
            tone="slate"
            action={
              <Button variant="ghost" onClick={() => log.mutate()} disabled={log.isPending} className="text-xs">
                {log.isPending ? 'Memuat…' : log.data ? 'Muat ulang' : 'Tampilkan log'}
              </Button>
            }
          />
          {log.data && (
            <Card className="p-3">
              {log.data.length === 0 ? (
                <p className="py-2 text-center text-sm text-slate-500">Log kosong.</p>
              ) : (
                <div className="space-y-1 font-mono text-xs">
                  {log.data.map((l, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="shrink-0 text-slate-500">{l.time}</span>
                      <span className="shrink-0 text-sky-400/80">{l.topics}</span>
                      <span className="text-slate-300">{l.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </section>
      </PageBody>
    </Page>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-400">{k}</dt>
      <dd className="truncate font-mono text-slate-200">{v}</dd>
    </div>
  );
}
