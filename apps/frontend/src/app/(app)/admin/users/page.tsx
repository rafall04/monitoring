'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ROLES, type Role } from '@noc/shared';
import { api } from '@/lib/api';
import { qk, useAppUsers, useSites } from '@/lib/queries';
import { Button, Card, Field, Select, Spinner, TextInput } from '@/components/ui';

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const users = useAppUsers();
  const sites = useSites();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.users });

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
      refresh();
    },
  });
  const toggleActive = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.patch(`/users/${v.id}`, { isActive: v.isActive }),
    onSuccess: refresh,
  });
  const delUser = useMutation({ mutationFn: (id: string) => api.del(`/users/${id}`), onSuccess: refresh });

  const toggleScope = (siteId: string) =>
    setForm((f) => ({
      ...f,
      scopeSiteIds: f.scopeSiteIds.includes(siteId)
        ? f.scopeSiteIds.filter((s) => s !== siteId)
        : [...f.scopeSiteIds, siteId],
    }));

  return (
    <div className="h-full space-y-6 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold text-slate-100">App Users &amp; Roles</h1>

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

      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-slate-200">Users</h2>
        {users.isLoading ? (
          <Spinner />
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
                <tr key={u.id} className="border-t border-surface-border">
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
                  <td className="text-right">
                    <button className="text-red-400 hover:text-red-300" onClick={() => delUser.mutate(u.id)}>
                      delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
