'use client';

import { useMemo, useState } from 'react';
import type { RuijieAccountPublic, RuijieRouterPublic } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  useCreateRuijieAccount,
  useDeleteRuijieAccount,
  useRuijieAccounts,
  useRuijieProjects,
  useRuijieRouterClients,
  useRuijieRouters,
  useSaveRuijieMonitored,
} from '@/lib/queries';
import { useConfirm, useToast } from '@/lib/toast';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Page,
  PageBody,
  PageHeader,
  TextInput,
} from '@/components/ui';

export default function RuijiePage() {
  const { can } = useAuth();
  const routers = useRuijieRouters();
  const [selected, setSelected] = useState<string | null>(null);

  const list = routers.data ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, RuijieRouterPublic[]>();
    for (const r of list) m.set(r.groupName, [...(m.get(r.groupName) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);
  const totalClients = list.reduce((n, r) => n + r.clientCount, 0);
  const online = list.filter((r) => r.online).length;

  return (
    <Page>
      <PageHeader
        title="Ruijie WiFi"
        subtitle={
          list.length
            ? `${online}/${list.length} AP online · ${totalClients} client terkoneksi`
            : 'Status & jumlah client per access point'
        }
      />
      <PageBody width="wide">
        {can('ruijie:manage') && <AccountsPanel />}

        {routers.isError ? (
          <ErrorState onRetry={() => void routers.refetch()}>Gagal memuat data Ruijie.</ErrorState>
        ) : routers.isLoading ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState>
            Belum ada data Ruijie.{' '}
            {can('ruijie:manage')
              ? 'Tambahkan akun Ruijie Cloud di atas — worker akan mulai poll otomatis.'
              : 'Minta admin menambahkan akun Ruijie Cloud.'}
          </EmptyState>
        ) : (
          groups.map(([name, rs]) => (
            <RouterGroup
              key={name}
              name={name}
              routers={rs}
              selected={selected}
              onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
            />
          ))
        )}
      </PageBody>
    </Page>
  );
}

function RouterGroup({
  name,
  routers,
  selected,
  onSelect,
}: {
  name: string;
  routers: RuijieRouterPublic[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const clients = routers.reduce((n, r) => n + r.clientCount, 0);
  const online = routers.filter((r) => r.online).length;
  return (
    <Card className="p-0">
      <header className="flex flex-wrap items-center gap-2 border-b border-surface-border px-4 py-2.5">
        <h2 className="font-semibold text-slate-100">{name}</h2>
        <span className="text-xs text-slate-500">
          {online}/{routers.length} online
        </span>
        <span className="ml-auto rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">
          {clients} client
        </span>
      </header>
      <div className="divide-y divide-surface-border">
        {routers.map((r) => (
          <RouterRow key={r.id} r={r} open={selected === r.id} onToggle={() => onSelect(r.id)} />
        ))}
      </div>
    </Card>
  );
}

function RouterRow({ r, open, onToggle }: { r: RuijieRouterPublic; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface/40"
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${r.online ? 'bg-emerald-500' : 'bg-slate-500'}`}
          title={r.online ? 'online' : 'offline'}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-100">{r.name}</span>
          <span className="block truncate text-xs text-slate-500">
            {r.model ?? 'Reyee'} · {r.localIp ?? '—'}
            {r.mac ? ` · ${r.mac}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="text-lg font-semibold text-slate-100">{r.clientCount}</span>
          <span className="block text-[10px] text-slate-500">
            client{r.activeClients !== r.clientCount ? ` · ${r.activeClients} aktif` : ''}
          </span>
        </span>
        <span className="ml-1 shrink-0 text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && <ClientDrill routerId={r.id} online={r.online} count={r.clientCount} />}
    </div>
  );
}

function ClientDrill({ routerId, online, count }: { routerId: string; online: boolean; count: number }) {
  const q = useRuijieRouterClients(online && count > 0 ? routerId : null);
  if (!online || count === 0) {
    return <div className="px-4 pb-3 text-xs text-slate-500">Tidak ada client terkoneksi.</div>;
  }
  const clients = q.data ?? [];
  return (
    <div className="px-3 pb-3 sm:px-4">
      {q.isError ? (
        <ErrorState onRetry={() => void q.refetch()}>Gagal memuat daftar client.</ErrorState>
      ) : q.isLoading ? (
        <Loading />
      ) : clients.length === 0 ? (
        <p className="py-2 text-xs text-slate-500">Detail client tidak tersedia.</p>
      ) : (
        // Responsive list (not a wide table) so it stays tidy on a phone: each
        // client wraps to its own lines on narrow screens, one row on desktop.
        <ul className="divide-y divide-surface-border overflow-hidden rounded-md border border-surface-border">
          {clients.map((s) => (
            <li key={s.mac} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="text-sm font-medium text-slate-100">{s.hostname ?? s.os ?? '?'}</span>
              {s.band && (
                <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-slate-400">
                  {s.band}
                  {s.rssi != null ? ` · ${s.rssi}dBm` : ''}
                </span>
              )}
              {s.ssid && <span className="truncate text-xs text-slate-500">{s.ssid}</span>}
              {s.apName && <span className="text-[10px] text-slate-500">via {s.apName}</span>}
              <span className="ml-auto text-right text-xs leading-tight text-slate-400">
                <span className="block">{s.ip ?? '—'}</span>
                <span className="block font-mono text-[10px] text-slate-500">{s.mac}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- super_admin: Ruijie Cloud account management ---------------------------

function AccountsPanel() {
  const accounts = useRuijieAccounts();
  const create = useCreateRuijieAccount();
  const del = useDeleteRuijieAccount();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({
    label: 'Ruijie Cloud',
    appId: '',
    appSecret: '',
    baseUrl: 'https://cloud-as.ruijienetworks.com',
  });
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const submit = () =>
    create.mutate(
      { label: form.label, appId: form.appId, appSecret: form.appSecret, baseUrl: form.baseUrl },
      {
        onSuccess: () => {
          setForm({ ...form, appId: '', appSecret: '' });
          toast.ok('Akun Ruijie ditambahkan — worker akan mulai poll.');
        },
        onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
      },
    );

  const test = async (id: string) => {
    setTestMsg((p) => ({ ...p, [id]: 'menguji…' }));
    try {
      const r = await api.post<{ ok: boolean; devices?: number; online?: number; error?: string }>(
        `/ruijie/accounts/${id}/test`,
        {},
      );
      setTestMsg((p) => ({
        ...p,
        [id]: r.ok ? `OK · ${r.online}/${r.devices} online` : `GAGAL · ${r.error}`,
      }));
    } catch (e) {
      setTestMsg((p) => ({ ...p, [id]: `GAGAL · ${(e as Error).message}` }));
    }
  };

  const remove = async (id: string, label: string) => {
    const ok = await confirm({
      title: 'Hapus akun Ruijie?',
      body: `${label} dan semua router-nya akan dihapus dari NOC.`,
      confirmLabel: 'Hapus',
      danger: true,
    });
    if (ok) del.mutate(id);
  };

  const hasAccount = (accounts.data?.length ?? 0) > 0;
  const picked = accounts.data?.find((a) => a.id === pickerFor) ?? null;
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold text-slate-200">Akun Ruijie Cloud</h2>

      {accounts.isLoading ? (
        <Loading />
      ) : !hasAccount ? (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <Field label="Label">
              <TextInput value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </Field>
            <Field label="App ID">
              <TextInput value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} />
            </Field>
            <Field label="App Secret">
              <TextInput
                type="password"
                value={form.appSecret}
                onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
              />
            </Field>
            <Field label="Base URL">
              <TextInput value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </Field>
          </div>
          <Button onClick={submit} disabled={!form.appId || !form.appSecret || create.isPending}>
            {create.isPending ? 'Menyimpan…' : 'Tambah akun'}
          </Button>
          <p className="text-xs text-slate-500">
            App ID + Secret (read-only) dari Ruijie Cloud. Hanya 1 akun didukung; setelah ditambah, pilih
            project mana yang dipantau.
          </p>
        </>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1">Label</th>
                  <th>App ID</th>
                  <th>Dipantau</th>
                  <th>Status</th>
                  <th className="text-right">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {(accounts.data ?? []).map((a) => (
                  <tr key={a.id} className="border-t border-surface-border">
                    <td className="py-1.5">{a.label}</td>
                    <td className="font-mono text-[11px] text-slate-400">{a.appId}</td>
                    <td className="whitespace-nowrap">
                      {a.routerCount} router · {a.monitoredGroupIds.length} project
                    </td>
                    <td className="text-xs">
                      {a.lastError ? (
                        <span className="text-red-400" title={a.lastError}>
                          error
                        </span>
                      ) : a.lastPolledAt ? (
                        <span className="text-emerald-400">poll {timeAgo(a.lastPolledAt)}</span>
                      ) : (
                        <span className="text-slate-500">belum poll</span>
                      )}
                      {testMsg[a.id] && <span className="ml-2 text-slate-400">{testMsg[a.id]}</span>}
                    </td>
                    <td className="space-x-3 whitespace-nowrap py-1.5 text-right text-xs">
                      <button
                        className="text-accent hover:opacity-80"
                        onClick={() => setPickerFor((cur) => (cur === a.id ? null : a.id))}
                      >
                        Project
                      </button>
                      <button className="text-accent hover:opacity-80" onClick={() => void test(a.id)}>
                        Test
                      </button>
                      <button
                        className="text-red-400 hover:text-red-300"
                        onClick={() => void remove(a.id, a.label)}
                      >
                        Hapus
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {picked && <ProjectPicker account={picked} onClose={() => setPickerFor(null)} />}

          {!pickerFor && (accounts.data ?? []).some((a) => a.monitoredGroupIds.length === 0) && (
            <p className="text-xs text-amber-400">
              Belum ada project dipilih — klik <b>Project</b> untuk memilih site yang dipantau, lalu
              router-nya akan muncul.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function ProjectPicker({ account, onClose }: { account: RuijieAccountPublic; onClose: () => void }) {
  const projects = useRuijieProjects(account.id);
  const save = useSaveRuijieMonitored();
  const toast = useToast();
  const [sel, setSel] = useState<Set<string>>(() => new Set(account.monitoredGroupIds));

  const toggle = (gid: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(gid)) n.delete(gid);
      else n.add(gid);
      return n;
    });

  const onSave = () =>
    save.mutate(
      { id: account.id, monitoredGroupIds: [...sel] },
      {
        onSuccess: (r) => {
          toast.ok(`Tersimpan — ${r?.poll?.devices ?? 0} router dipantau.`);
          onClose();
        },
        onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
      },
    );

  return (
    <div className="space-y-2 rounded-md border border-surface-border bg-surface/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Pilih project yang dipantau</h3>
        <span className="text-xs text-slate-500">{sel.size} dipilih</span>
      </div>
      {projects.isError ? (
        <ErrorState onRetry={() => void projects.refetch()}>Gagal memuat project dari Ruijie.</ErrorState>
      ) : projects.isLoading ? (
        <Loading />
      ) : (projects.data?.length ?? 0) === 0 ? (
        <p className="text-xs text-slate-500">Tidak ada project di akun ini.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-surface-border overflow-y-auto rounded border border-surface-border">
          {(projects.data ?? []).map((p) => (
            <li key={p.groupId}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface/40">
                <input type="checkbox" checked={sel.has(p.groupId)} onChange={() => toggle(p.groupId)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-100">{p.groupName}</span>
                  <span className="block text-xs text-slate-500">
                    {p.onlineCount}/{p.deviceCount} online · {p.clientCount} client
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onSave} disabled={save.isPending || projects.isLoading}>
          {save.isPending ? 'Menyimpan…' : 'Simpan'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Tutup
        </Button>
        <span className="text-[11px] text-slate-500">
          Centang site yang dipantau NOC; sisanya (rumah/pribadi) diabaikan.
        </span>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s lalu`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m lalu`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}j lalu`;
  return `${Math.floor(sec / 86400)}h lalu`;
}
