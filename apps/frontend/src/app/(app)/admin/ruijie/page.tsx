'use client';

import { useState } from 'react';
import type { RuijieAccountPublic } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  useCreateRuijieAccount,
  useDeleteRuijieAccount,
  useRuijieAccounts,
  useRuijieProjects,
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

// Ruijie Cloud account management — credentials + which projects the NOC
// monitors. Kept SEPARATE from the /ruijie monitoring view on purpose: the
// monitoring page stays clean of any secret-bearing forms. super_admin only.
export default function AdminRuijiePage() {
  const { can } = useAuth();
  if (!can('ruijie:manage')) {
    return (
      <Page>
        <PageHeader title="Ruijie Cloud" subtitle="Manajemen akun & project yang dipantau." />
        <PageBody>
          <EmptyState>Khusus super admin.</EmptyState>
        </PageBody>
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader
        title="Ruijie Cloud"
        subtitle="Kelola akun Cloud (App ID/Secret) dan pilih project yang dipantau NOC."
      />
      <PageBody>
        <AccountsPanel />
      </PageBody>
    </Page>
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
              router-nya akan muncul di halaman Ruijie WiFi.
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
