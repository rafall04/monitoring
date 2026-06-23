'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { ROLES, type AppUserPublic, type Role, type Site } from '@noc/shared';
import { api } from '@/lib/api';
import { qk, useAppUsers, useSites } from '@/lib/queries';
import { useConfirm, useToast } from '@/lib/toast';
import { Button, Card, Field, Loading, Page, PageBody, PageHeader, Select, TextInput } from '@/components/ui';

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const users = useAppUsers();
  const sites = useSites();
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.users });
  const [editId, setEditId] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'user' as Role,
    scopeSiteIds: [] as string[],
  });

  const addUser = useMutation({
    mutationFn: () => api.post('/users', form),
    onSuccess: () => {
      setForm({ name: '', email: '', password: '', role: 'user', scopeSiteIds: [] });
      toast.ok('User dibuat');
      refresh();
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
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

  const toggleScope = (siteId: string) =>
    setForm((f) => ({
      ...f,
      scopeSiteIds: f.scopeSiteIds.includes(siteId)
        ? f.scopeSiteIds.filter((s) => s !== siteId)
        : [...f.scopeSiteIds, siteId],
    }));

  return (
    <Page>
      <PageHeader title="App Users & Roles" subtitle="Kelola akun, peran, dan cakupan site." />
      <PageBody>
        <Card className="p-4">
        <h2 className="mb-3 font-semibold text-slate-200">New user</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><TextInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Password"><TextInput type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
        </div>
        {form.role !== 'super_admin' && (
          <div className="mt-3">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
              Scoped sites
            </span>
            <div className="flex flex-wrap gap-3">
              {sites.data?.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={form.scopeSiteIds.includes(s.id)} onChange={() => toggleScope(s.id)} />
                  {s.name}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="mt-3">
          <Button onClick={() => addUser.mutate()} disabled={!form.name || !form.email || form.password.length < 8}>
            Create user
          </Button>
          {addUser.isError && <span className="ml-3 text-sm text-red-400">{(addUser.error as Error).message}</span>}
        </div>
      </Card>

      <Card className="overflow-x-auto p-4">
        <h2 className="mb-3 font-semibold text-slate-200">Users</h2>
        {users.isLoading ? (
          <Loading />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1">Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Scope</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <Fragment key={u.id}>
                  <tr className="border-t border-surface-border">
                    <td className="py-1.5">{u.name}</td>
                    <td>{u.email}</td>
                    <td>{u.role}</td>
                    <td className="text-xs text-slate-400">
                      {u.role === 'super_admin' ? 'all' : `${u.scopeSiteIds.length} sites`}
                    </td>
                    <td>
                      <button
                        className={u.isActive ? 'text-emerald-400' : 'text-slate-500'}
                        onClick={() => toggleActive.mutate({ id: u.id, isActive: !u.isActive })}
                      >
                        {u.isActive ? 'active' : 'inactive'}
                      </button>
                    </td>
                    <td className="space-x-3 text-right">
                      <button
                        className="text-accent hover:opacity-80"
                        onClick={() => setEditId((cur) => (cur === u.id ? null : u.id))}
                      >
                        {editId === u.id ? 'close' : 'edit'}
                      </button>
                      <button className="text-red-400 hover:text-red-300" onClick={() => askDelete(u.id, u.name)}>
                        delete
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
    </Page>
  );
}

function EditUserForm({
  user,
  sites,
  onDone,
}: {
  user: AppUserPublic;
  sites: Site[];
  onDone: () => void;
}) {
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

  const toggleScope = (siteId: string) =>
    setForm((f) => ({
      ...f,
      scopeSiteIds: f.scopeSiteIds.includes(siteId)
        ? f.scopeSiteIds.filter((s) => s !== siteId)
        : [...f.scopeSiteIds, siteId],
    }));

  const pwTooShort = form.password.length > 0 && form.password.length < 8;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="Name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Email"><TextInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="New password (blank = keep)">
          <TextInput type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
        </Field>
        <Field label="Role">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
      </div>

      {form.role !== 'super_admin' && (
        <div>
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Scoped sites</span>
          <div className="flex flex-wrap gap-3">
            {sites.map((s) => (
              <label key={s.id} className="flex items-center gap-1.5 text-sm text-slate-300">
                <input type="checkbox" checked={form.scopeSiteIds.includes(s.id)} onChange={() => toggleScope(s.id)} />
                {s.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
        Active (can sign in)
      </label>

      <div className="flex items-center gap-2">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || !form.name || !form.email || pwTooShort}
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        {pwTooShort && <span className="text-sm text-amber-400">Password min. 8 characters</span>}
        {save.isError && <span className="text-sm text-red-400">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}
