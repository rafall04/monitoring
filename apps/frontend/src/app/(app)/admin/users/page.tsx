'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ROLES, type AppUserPublic, type Role, type Site } from '@noc/shared';
import { api } from '@/lib/api';
import { qk, useAppUsers, useSites } from '@/lib/queries';
import { useConfirm, useToast } from '@/lib/toast';
import { Button, Card, Field, Loading, Page, PageBody, PageHeader, Select, TextInput } from '@/components/ui';

const ROLE_HINT: Record<Role, string> = {
  viewer: 'Read-only — pantau peta, status device, Ruijie & laporan. Tak bisa mengubah apa pun.',
  operator:
    'Bisa edit/tambah device (IP/atribut), kelola hotspot, ack/silence alert. Tak bisa hapus, kredensial, atau settings.',
  super_admin: 'Akses penuh — kredensial router & Ruijie, user, settings, audit, hapus.',
};

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const users = useAppUsers();
  const sites = useSites();
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.users });

  const [editId, setEditId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const toggleActive = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.patch(`/users/${v.id}`, { isActive: v.isActive }),
    onSuccess: refresh,
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const delUser = useMutation({
    mutationFn: (id: string) => api.del(`/users/${id}`),
    onSuccess: () => {
      toast.ok('User dihapus');
      refresh();
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const askDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Hapus user?',
      body: `${name} akan kehilangan akses. Tindakan ini tidak bisa di-undo.`,
      confirmLabel: 'Hapus',
      danger: true,
    });
    if (ok) delUser.mutate(id);
  };

  const needle = search.trim().toLowerCase();
  const filtered = (users.data ?? []).filter((u) => {
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter === 'active' && !u.isActive) return false;
    if (statusFilter === 'inactive' && u.isActive) return false;
    if (needle && !(u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))) return false;
    return true;
  });

  return (
    <Page>
      <PageHeader
        title="App Users & Roles"
        subtitle="Kelola akun, peran, dan cakupan site."
        actions={<Button onClick={() => setShowAdd(true)}>+ Tambah user</Button>}
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari nama / email…"
            className="w-full sm:w-56"
          />
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="w-36">
            <option value="">Semua role</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-36">
            <option value="">Semua status</option>
            <option value="active">Aktif</option>
            <option value="inactive">Nonaktif</option>
          </Select>
          <span className="text-xs text-slate-500">{filtered.length} user</span>
        </div>

        <Card className="overflow-x-auto p-4">
          {users.isLoading ? (
            <Loading />
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              {users.data?.length ? 'Tak ada user yang cocok dengan filter.' : 'Belum ada user.'}
            </p>
          ) : (
            <table className="r-table w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1">Nama</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Cakupan</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <Fragment key={u.id}>
                    <tr className="border-t border-surface-border">
                      <td data-label="Nama" className="py-1.5">{u.name}</td>
                      <td data-label="Email">{u.email}</td>
                      <td data-label="Role">{u.role}</td>
                      <td data-label="Cakupan" className="text-xs text-slate-400">
                        {u.role === 'super_admin' ? 'semua' : `${u.scopeSiteIds.length} site`}
                      </td>
                      <td data-label="Status">
                        <button
                          className={u.isActive ? 'text-emerald-400' : 'text-slate-500'}
                          onClick={() => toggleActive.mutate({ id: u.id, isActive: !u.isActive })}
                        >
                          {u.isActive ? 'aktif' : 'nonaktif'}
                        </button>
                      </td>
                      <td className="space-x-3 text-right">
                        <button
                          className="text-accent hover:opacity-80"
                          onClick={() => setEditId((cur) => (cur === u.id ? null : u.id))}
                        >
                          {editId === u.id ? 'tutup' : 'edit'}
                        </button>
                        <button className="text-red-400 hover:text-red-300" onClick={() => askDelete(u.id, u.name)}>
                          hapus
                        </button>
                      </td>
                    </tr>
                    {editId === u.id && (
                      <tr className="border-t border-surface-border bg-surface/40">
                        <td colSpan={6} className="p-3">
                          <EditUserForm
                            user={u}
                            sites={sites.data ?? []}
                            onDone={() => {
                              setEditId(null);
                              refresh();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </PageBody>

      {showAdd && (
        <AddUserModal sites={sites.data ?? []} onClose={() => setShowAdd(false)} onDone={refresh} />
      )}
    </Page>
  );
}

// ---- Add-user modal ---------------------------------------------------------

function AddUserModal({ sites, onClose, onDone }: { sites: Site[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'viewer' as Role,
    scopeSiteIds: [] as string[],
  });
  const add = useMutation({
    mutationFn: () =>
      api.post('/users', { ...form, scopeSiteIds: form.role === 'super_admin' ? [] : form.scopeSiteIds }),
    onSuccess: () => {
      toast.ok('User dibuat');
      onDone();
      onClose();
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const pwTooShort = form.password.length > 0 && form.password.length < 8;
  const valid = Boolean(form.name && form.email && form.password.length >= 8);

  return (
    <Modal title="Tambah user" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Nama"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><TextInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Password">
            <TextInput type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min. 8 karakter" />
          </Field>
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
        </div>
        <p className="rounded border border-surface-border bg-surface/40 p-2 text-xs text-slate-400">
          {ROLE_HINT[form.role]}
        </p>
        {form.role !== 'super_admin' && (
          <ScopedSitesPicker
            sites={sites}
            selected={form.scopeSiteIds}
            onChange={(ids) => setForm({ ...form, scopeSiteIds: ids })}
          />
        )}
      </div>
      <div className="mt-5 flex items-center justify-end gap-2 border-t border-surface-border pt-4">
        {pwTooShort && <span className="mr-auto text-xs text-amber-400">Password min. 8 karakter</span>}
        <Button variant="ghost" onClick={onClose}>Batal</Button>
        <Button onClick={() => add.mutate()} disabled={!valid || add.isPending}>
          {add.isPending ? 'Menyimpan…' : 'Buat user'}
        </Button>
      </div>
    </Modal>
  );
}

// ---- inline edit ------------------------------------------------------------

function EditUserForm({ user, sites, onDone }: { user: AppUserPublic; sites: Site[]; onDone: () => void }) {
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    role: user.role as Role,
    scopeSiteIds: user.scopeSiteIds,
    isActive: user.isActive,
    password: '',
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/users/${user.id}`, {
        name: form.name,
        email: form.email,
        role: form.role,
        scopeSiteIds: form.role === 'super_admin' ? [] : form.scopeSiteIds,
        isActive: form.isActive,
        ...(form.password ? { password: form.password } : {}),
      }),
    onSuccess: onDone,
  });

  const pwTooShort = form.password.length > 0 && form.password.length < 8;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nama"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><TextInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Password baru (kosong = tetap)">
          <TextInput type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
        </Field>
        <Field label="Role">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
      </div>
      <p className="rounded border border-surface-border bg-surface/40 p-2 text-xs text-slate-400">{ROLE_HINT[form.role]}</p>

      {form.role !== 'super_admin' && (
        <ScopedSitesPicker
          sites={sites}
          selected={form.scopeSiteIds}
          onChange={(ids) => setForm((f) => ({ ...f, scopeSiteIds: ids }))}
        />
      )}

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
        Aktif (bisa login)
      </label>

      <div className="flex items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !form.name || !form.email || pwTooShort}>
          {save.isPending ? 'Menyimpan…' : 'Simpan'}
        </Button>
        <Button variant="ghost" onClick={onDone}>Batal</Button>
        {pwTooShort && <span className="text-sm text-amber-400">Password min. 8 karakter</span>}
        {save.isError && <span className="text-sm text-red-400">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}

// ---- shared bits ------------------------------------------------------------

/** Structured site-scope picker: search + grouped by kabupaten + select all/clear. */
function ScopedSitesPicker({
  sites,
  selected,
  onChange,
}: {
  sites: Site[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const sel = new Set(selected);
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? sites.filter((s) => s.name.toLowerCase().includes(needle) || (s.region ?? '').toLowerCase().includes(needle))
    : sites;
  const groups = new Map<string, Site[]>();
  for (const s of filtered) {
    const k = s.region?.trim() || 'Tanpa kabupaten';
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const toggle = (id: string) => onChange(sel.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Cakupan site · {selected.length} dipilih
        </span>
        <span className="flex gap-3 text-xs">
          <button type="button" className="text-accent hover:opacity-80" onClick={() => onChange(sites.map((s) => s.id))}>
            Semua
          </button>
          <button type="button" className="text-slate-400 hover:text-slate-200" onClick={() => onChange([])}>
            Kosongkan
          </button>
        </span>
      </div>
      <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari site / kabupaten…" className="mb-2" />
      <div className="max-h-44 space-y-2 overflow-y-auto rounded border border-surface-border p-2">
        {[...groups.entries()].map(([region, ss]) => (
          <div key={region}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{region}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {ss.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} />
                  {s.name}
                </label>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">Tak ada site cocok.</p>}
      </div>
    </div>
  );
}

/** Lightweight centered modal (overlay click + Esc to close), matching the
 *  Confirm/Prompt dialogs in lib/toast. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-surface-border bg-surface-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-3">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200" aria-label="Tutup">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
