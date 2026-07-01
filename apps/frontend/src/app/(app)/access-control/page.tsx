'use client';

import { useMemo, useState } from 'react';
import type { FirewallBlockRule } from '@noc/shared';
import { useAuth } from '@/lib/auth';
import {
  useAddAddressEntry,
  useAddressList,
  useFirewallBlocks,
  useRemoveAddressEntry,
  useRouters,
  useToggleBlock,
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

function Ic({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const SHIELD = 'M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z';
const BAN = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8';

function Switch({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${on ? 'noc-accent-grad' : 'bg-slate-500/40'}`}
    >
      <span
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all"
        style={{ left: on ? 22 : 2 }}
      />
    </button>
  );
}

/** A friendly display name for a block rule (comment, else its method). */
function blockLabel(b: FirewallBlockRule): string {
  if (b.comment) return b.comment;
  return b.method || 'Rule tanpa nama';
}

export default function AccessControlPage() {
  const { can } = useAuth();
  const routers = useRouters();
  const [rid, setRid] = useState<string | null>(null);
  const routerId = rid ?? routers.data?.[0]?.id ?? null;

  const canManage = can('firewall:manage');
  const toast = useToast();
  const confirm = useConfirm();

  const blocks = useFirewallBlocks(routerId);
  const toggle = useToggleBlock(routerId ?? '');

  const named = (blocks.data ?? []).filter((b) => b.comment);
  const unnamed = (blocks.data ?? []).filter((b) => !b.comment);

  const onToggle = async (b: FirewallBlockRule) => {
    const turningOn = !b.active;
    const ok = await confirm({
      title: turningOn ? `Aktifkan blok "${blockLabel(b)}"?` : `Nonaktifkan blok "${blockLabel(b)}"?`,
      body: turningOn
        ? 'Akses yang cocok dengan rule ini akan DIBLOKIR.'
        : 'Rule blokir ini akan DIMATIKAN (akses dibuka).',
      confirmLabel: turningOn ? 'Blokir' : 'Buka',
      danger: turningOn,
    });
    if (!ok) return;
    toggle.mutate(
      { ruleId: b.id, active: turningOn },
      {
        onSuccess: (r) => {
          toast.ok(turningOn ? 'Blok diaktifkan' : 'Blok dinonaktifkan');
          if (r.backup === 'failed') toast.error('Perubahan diterapkan, tapi backup config GAGAL.');
        },
        onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
      },
    );
  };

  return (
    <Page>
      <PageHeader
        title="Access Control"
        subtitle="Blokir website/aplikasi & internet per device — langsung ke MikroTik."
        actions={
          <Select
            value={routerId ?? ''}
            onChange={(e) => setRid(e.target.value)}
            className="w-full sm:w-64"
          >
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
          <Card className="p-3 text-xs text-amber-400">
            Anda hanya bisa melihat (read-only). Perlu peran operator/admin untuk mengubah.
          </Card>
        )}

        {/* ---- Website / app blocks ---- */}
        <section>
          <SectionHeader title="Blok Website / Aplikasi" icon={<Ic d={SHIELD} />} tone="red" />
          <Card className="p-4">
            {blocks.isError ? (
              <ErrorState onRetry={() => void blocks.refetch()}>
                Gagal memuat — router mungkin tak terjangkau.
              </ErrorState>
            ) : blocks.isLoading ? (
              <Loading />
            ) : named.length === 0 && unnamed.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">
                Tidak ada rule blokir (forward drop/reject) di router ini.
              </p>
            ) : (
              <div className="space-y-2">
                {named.map((b) => (
                  <BlockRow key={b.id} b={b} canManage={canManage} onToggle={() => onToggle(b)} />
                ))}
                {unnamed.length > 0 && (
                  <details className="mt-2 rounded-lg border border-dashed border-surface-border p-2">
                    <summary className="cursor-pointer text-xs text-slate-500">
                      {unnamed.length} rule tanpa nama (beri comment di router agar rapi)
                    </summary>
                    <div className="mt-2 space-y-2">
                      {unnamed.map((b) => (
                        <BlockRow key={b.id} b={b} canManage={canManage} onToggle={() => onToggle(b)} />
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </Card>
        </section>

        {/* ---- Block a device (address-list) ---- */}
        <section>
          <SectionHeader title="Blok Internet per Device" icon={<Ic d={BAN} />} tone="amber" />
          <DeviceBlock routerId={routerId} canManage={canManage} />
        </section>
      </PageBody>
    </Page>
  );
}

function BlockRow({
  b,
  canManage,
  onToggle,
}: {
  b: FirewallBlockRule;
  canManage: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface/50 p-3">
      <IconTile tone={b.active ? 'red' : 'slate'}>
        <Ic d={SHIELD} />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-200">{blockLabel(b)}</div>
        <div className="truncate text-[11px] text-slate-500">
          {b.method} · {b.action}
        </div>
      </div>
      <Badge tone={b.active ? 'red' : 'slate'}>{b.active ? 'diblokir' : 'terbuka'}</Badge>
      <Switch on={b.active} onClick={onToggle} disabled={!canManage} />
    </div>
  );
}

function DeviceBlock({ routerId, canManage }: { routerId: string | null; canManage: boolean }) {
  const all = useAddressList(routerId, null);
  const toast = useToast();
  const confirm = useConfirm();
  const add = useAddAddressEntry(routerId ?? '');
  const remove = useRemoveAddressEntry(routerId ?? '');

  const lists = useMemo(
    () => [...new Set((all.data ?? []).map((e) => e.list))].sort((a, b) => a.localeCompare(b)),
    [all.data],
  );
  const [list, setList] = useState('');
  const [address, setAddress] = useState('');
  const selectedList = list || lists[0] || '';
  const entries = (all.data ?? []).filter((e) => e.list === selectedList);

  const onAdd = () => {
    if (!address.trim() || !selectedList) return;
    add.mutate(
      { list: selectedList, address: address.trim(), comment: 'via NOC' },
      {
        onSuccess: (r) => {
          toast.ok(`${address} ditambahkan ke ${selectedList}`);
          if (r.backup === 'failed') toast.error('Diterapkan, tapi backup config GAGAL.');
          setAddress('');
        },
        onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
      },
    );
  };
  const onRemove = async (id: string, addr: string) => {
    const ok = await confirm({
      title: `Hapus ${addr} dari ${selectedList}?`,
      body: 'Device ini akan lepas dari daftar (blokir/izin sesuai rule terkait).',
      confirmLabel: 'Hapus',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(id, {
      onSuccess: () => toast.ok('Dihapus'),
      onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
    });
  };

  return (
    <Card className="p-4">
      {all.isError ? (
        <ErrorState onRetry={() => void all.refetch()}>Gagal memuat address-list.</ErrorState>
      ) : all.isLoading ? (
        <Loading />
      ) : lists.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">Belum ada address-list di router ini.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={selectedList} onChange={(e) => setList(e.target.value)} className="sm:w-48">
              {lists.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
            <TextInput
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="IP / CIDR device (mis. 192.168.101.50)"
              className="sm:flex-1"
              disabled={!canManage}
            />
            <Button onClick={onAdd} disabled={!canManage || !address.trim() || add.isPending}>
              {add.isPending ? 'Menambah…' : '+ Blokir'}
            </Button>
          </div>

          <div className="mt-3 divide-y divide-surface-border">
            {entries.length === 0 && (
              <p className="py-3 text-center text-xs text-slate-500">List "{selectedList}" kosong.</p>
            )}
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="font-mono text-slate-200">{e.address}</span>
                {e.dynamic && <Badge tone="slate">dinamis</Badge>}
                {e.comment && <span className="truncate text-[11px] text-slate-500">{e.comment}</span>}
                {canManage && !e.dynamic && (
                  <button
                    onClick={() => onRemove(e.id, e.address)}
                    className="ml-auto text-xs text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                  >
                    hapus
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
