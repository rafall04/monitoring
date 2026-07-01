'use client';

import { useMemo, useState } from 'react';
import type { SimpleQueueDTO } from '@noc/shared';
import { useAuth } from '@/lib/auth';
import {
  useAddQueue,
  useDhcpLeases,
  useRemoveQueue,
  useRouters,
  useSetLeaseRate,
  useSetQueueMax,
  useSimpleQueues,
} from '@/lib/queries';
import { useConfirm, useToast } from '@/lib/toast';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  IconTile,
  Loading,
  Page,
  PageBody,
  PageHeader,
  SectionHeader,
  Select,
  TextInput,
} from '@/components/ui';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}
function bytesOf(pair: string): { up: number; down: number; total: number } {
  const parts = (pair || '0/0').split('/');
  const up = Number(parts[0]) || 0;
  const down = Number(parts[1]) || 0;
  return { up, down, total: up + down };
}
const cleanName = (n: string) => n.replace(/^<hotspot-?/, '').replace(/>$/, '');

// Simple, human presets. `ros` is what RouterOS stores (bit/s syntax).
const RATE_OPTIONS: { label: string; ros: string }[] = [
  { label: 'Unlimited', ros: '0/0' },
  { label: '512 Kbps', ros: '512k/512k' },
  { label: '1 Mbps', ros: '1M/1M' },
  { label: '2 Mbps', ros: '2M/2M' },
  { label: '3 Mbps', ros: '3M/3M' },
  { label: '5 Mbps', ros: '5M/5M' },
  { label: '10 Mbps', ros: '10M/10M' },
  { label: '20 Mbps', ros: '20M/20M' },
  { label: '50 Mbps', ros: '50M/50M' },
];

/** Parse a RouterOS rate token ("5000000", "5M", "512k", "0") into bit/s. */
function toBps(t: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/.exec((t ?? '').trim());
  if (!m) return 0;
  const mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9, '': 1 }[m[2] ?? ''] ?? 1;
  return Number(m[1]) * mult;
}
function fmtBps(n: number): string {
  if (n <= 0) return '∞';
  if (n >= 1e6) return `${Math.round((n / 1e6) * 10) / 10} Mbps`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} Kbps`;
  return `${n} bps`;
}
/** Human label for a "up/down" max-limit pair. */
function fmtRate(pair: string): string {
  const [up, down] = (pair || '0/0').split('/');
  const u = toBps(up);
  const d = toBps(down);
  if (u <= 0 && d <= 0) return 'Unlimited';
  if (u === d) return fmtBps(u);
  return `↑${fmtBps(u)} · ↓${fmtBps(d)}`;
}
/** Which preset matches a stored rate (by bit/s), or '' if custom. */
function matchOption(pair: string): string {
  const [up, down] = (pair || '0/0').split('/');
  const u = toBps(up);
  const d = toBps(down);
  const found = RATE_OPTIONS.find((o) => {
    const [ou, od] = o.ros.split('/');
    return toBps(ou) === u && toBps(od) === d;
  });
  return found?.ros ?? '';
}

function Ic({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const GAUGE = 'M12 3a9 9 0 1 0 9 9M12 12l5-3';
const LIST = 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01';
const DHCP = 'M4 7h16M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7M9 12h6';

export default function BandwidthPage() {
  const { can } = useAuth();
  const routers = useRouters();
  const [rid, setRid] = useState<string | null>(null);
  const routerId = rid ?? routers.data?.[0]?.id ?? null;
  const canManage = can('bandwidth:manage');

  const queues = useSimpleQueues(routerId);

  const talkers = useMemo(() => {
    return [...(queues.data ?? [])]
      .map((q) => ({ q, ...bytesOf(q.bytes) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }, [queues.data]);

  return (
    <Page>
      <PageHeader
        title="Bandwidth / QoS"
        subtitle="Batasi kecepatan per device (simple queue + DHCP rate-limit) & lihat pemakai terbesar."
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
        {!canManage && (
          <Card className="p-3 text-xs text-amber-400">Read-only — perlu operator/admin untuk mengubah.</Card>
        )}

        {/* Top talkers */}
        <section>
          <SectionHeader title="Pemakai Bandwidth Terbesar" icon={<Ic d={GAUGE} />} tone="violet" />
          <Card className="p-4">
            {queues.isLoading ? (
              <Loading />
            ) : talkers.length === 0 ? (
              <p className="py-3 text-center text-sm text-slate-500">Belum ada traffic tercatat di queue.</p>
            ) : (
              <div className="space-y-2">
                {talkers.map(({ q, up, down, total }, i) => {
                  const pct = Math.round((total / (talkers[0]?.total || 1)) * 100);
                  return (
                    <div key={q.id} className="flex items-center gap-3">
                      <span className="w-5 shrink-0 text-center text-xs font-semibold text-slate-500">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="truncate text-slate-200">{cleanName(q.name) || q.target}</span>
                          <span className="shrink-0 font-mono text-xs text-slate-400">
                            <span className="text-sky-600 dark:text-sky-400">↓{fmtBytes(down)}</span>{' '}
                            <span className="text-emerald-600 dark:text-emerald-400">↑{fmtBytes(up)}</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: '#8b5cf6' }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </section>

        {/* Simple queues */}
        <section>
          <SectionHeader title="Simple Queue (limit per device/subnet)" icon={<Ic d={LIST} />} tone="sky" />
          <QueueManager routerId={routerId} canManage={canManage} queues={queues} />
        </section>

        {/* DHCP leases */}
        <section>
          <SectionHeader title="Rate-limit via DHCP Lease" icon={<Ic d={DHCP} />} tone="amber" />
          <LeaseManager routerId={routerId} canManage={canManage} />
        </section>
      </PageBody>
    </Page>
  );
}

function QueueManager({
  routerId,
  canManage,
  queues,
}: {
  routerId: string | null;
  canManage: boolean;
  queues: ReturnType<typeof useSimpleQueues>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const addQ = useAddQueue(routerId ?? '');
  const setMax = useSetQueueMax(routerId ?? '');
  const removeQ = useRemoveQueue(routerId ?? '');

  const manual = (queues.data ?? []).filter((q) => !q.hotspot && !q.dynamic);
  const hotspotCount = (queues.data ?? []).filter((q) => q.hotspot).length;

  const [form, setForm] = useState({ name: '', target: '', maxLimit: '2M/2M' });
  const warn = (r: { backup: 'saved' | 'failed' }) =>
    r.backup === 'failed' && toast.error('Diterapkan, tapi backup config GAGAL.');

  const onAdd = () => {
    if (!form.name.trim() || !form.target.trim()) return;
    addQ.mutate(
      { name: form.name.trim(), target: form.target.trim(), maxLimit: form.maxLimit },
      {
        onSuccess: (r) => {
          toast.ok('Queue dibuat');
          warn(r);
          setForm({ name: '', target: '', maxLimit: '2M/2M' });
        },
        onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
      },
    );
  };
  const onSetMax = (q: SimpleQueueDTO, maxLimit: string) =>
    setMax.mutate(
      { qid: q.id, maxLimit },
      { onSuccess: (r) => { toast.ok('Limit diubah'); warn(r); }, onError: (e) => toast.error(`Gagal: ${(e as Error).message}`) },
    );
  const onRemove = async (q: SimpleQueueDTO) => {
    const ok = await confirm({ title: `Hapus queue "${q.name}"?`, body: 'Limit bandwidth untuk target ini dilepas.', confirmLabel: 'Hapus', danger: true });
    if (ok) removeQ.mutate(q.id, { onSuccess: (r) => { toast.ok('Queue dihapus'); warn(r); }, onError: (e) => toast.error(`Gagal: ${(e as Error).message}`) });
  };

  return (
    <Card className="p-4">
      {queues.isError ? (
        <ErrorState onRetry={() => void queues.refetch()}>Gagal memuat queue.</ErrorState>
      ) : queues.isLoading ? (
        <Loading />
      ) : (
        <>
          {canManage && (
            <div className="mb-3 grid grid-cols-1 gap-2 rounded-lg border border-dashed border-surface-border p-3 sm:grid-cols-[1fr_1fr_auto_auto]">
              <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nama (mis. Limit-PC-Gudang)" />
              <TextInput value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="Target IP/subnet" />
              <Select value={form.maxLimit} onChange={(e) => setForm({ ...form, maxLimit: e.target.value })} className="sm:w-32">
                {RATE_OPTIONS.map((o) => <option key={o.ros} value={o.ros}>{o.label}</option>)}
              </Select>
              <Button onClick={onAdd} disabled={addQ.isPending || !form.name.trim() || !form.target.trim()}>
                + Buat limit
              </Button>
            </div>
          )}

          <div className="space-y-2">
            {manual.length === 0 && <p className="py-2 text-center text-sm text-slate-500">Belum ada queue manual.</p>}
            {manual.map((q) => {
              const { up, down } = bytesOf(q.bytes);
              return (
                <div key={q.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-surface-border bg-surface/50 p-3">
                  <IconTile tone="sky"><Ic d={LIST} /></IconTile>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-200">{q.name}</div>
                    <div className="truncate font-mono text-[11px] text-slate-500">
                      {q.target} · ↓{fmtBytes(down)} ↑{fmtBytes(up)}
                    </div>
                  </div>
                  {canManage ? (
                    <Select value={matchOption(q.maxLimit)} onChange={(e) => e.target.value && onSetMax(q, e.target.value)} className="w-36">
                      {!matchOption(q.maxLimit) && <option value="">{fmtRate(q.maxLimit)}</option>}
                      {RATE_OPTIONS.map((o) => <option key={o.ros} value={o.ros}>{o.label}</option>)}
                    </Select>
                  ) : (
                    <Badge tone="sky">{fmtRate(q.maxLimit)}</Badge>
                  )}
                  {canManage && (
                    <button onClick={() => onRemove(q)} className="text-xs text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300">
                      hapus
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {hotspotCount > 0 && (
            <p className="mt-3 text-[11px] text-slate-500">
              + {hotspotCount} queue hotspot (otomatis, diatur dari profil Hotspot — tidak diedit di sini).
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function LeaseManager({ routerId, canManage }: { routerId: string | null; canManage: boolean }) {
  const leases = useDhcpLeases(routerId);
  const toast = useToast();
  const setRate = useSetLeaseRate(routerId ?? '');
  const [q, setQ] = useState('');
  const [rate, setRate2] = useState('2M/2M');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = leases.data ?? [];
    const withLimit = all.filter((l) => l.rateLimit);
    const matched = needle
      ? all.filter((l) => [l.address, l.macAddress, l.hostName ?? ''].some((v) => v.toLowerCase().includes(needle)))
      : withLimit; // default: show only leases that already have a limit
    return matched.slice(0, 40);
  }, [leases.data, q]);

  const apply = (lid: string, rateLimit: string, label: string) =>
    setRate.mutate(
      { lid, rateLimit },
      {
        onSuccess: (r) => { toast.ok(label); if (r.backup === 'failed') toast.error('Diterapkan, tapi backup config GAGAL.'); },
        onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
      },
    );

  return (
    <Card className="p-4">
      {leases.isError ? (
        <ErrorState onRetry={() => void leases.refetch()}>Gagal memuat DHCP lease.</ErrorState>
      ) : leases.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari IP / MAC / hostname…" className="sm:flex-1" />
            {canManage && (
              <Select value={rate} onChange={(e) => setRate2(e.target.value)} className="sm:w-36">
                {RATE_OPTIONS.filter((o) => o.ros !== '0/0').map((o) => <option key={o.ros} value={o.ros}>{o.label}</option>)}
              </Select>
            )}
          </div>
          <p className="mb-2 text-[11px] text-slate-500">
            {q ? `${rows.length} lease cocok` : `Menampilkan ${rows.length} lease yang sudah ada limit — cari untuk membatasi lease lain.`}
          </p>
          <div className="divide-y divide-surface-border">
            {rows.length === 0 && <p className="py-3 text-center text-sm text-slate-500">Tidak ada lease.</p>}
            {rows.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-mono text-slate-200">{l.address}</span>
                <span className="truncate font-mono text-[11px] text-slate-500">{l.macAddress}</span>
                {l.hostName && <span className="truncate text-[11px] text-slate-400">{l.hostName}</span>}
                {l.dynamic && <Badge tone="slate">dinamis</Badge>}
                {l.rateLimit ? <Badge tone="amber">{fmtRate(l.rateLimit)}</Badge> : <span className="text-[11px] text-slate-600">tanpa limit</span>}
                {canManage && (
                  <span className="ml-auto flex gap-3">
                    <button onClick={() => apply(l.id, rate, `Dibatasi ${fmtRate(rate)}`)} className="text-xs text-accent hover:opacity-80">
                      batasi {fmtRate(rate)}
                    </button>
                    {l.rateLimit && (
                      <button onClick={() => apply(l.id, '', 'Limit dilepas')} className="text-xs text-slate-400 hover:text-slate-200">
                        lepas
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
