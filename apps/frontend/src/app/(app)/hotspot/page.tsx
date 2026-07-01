'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import type { HotspotActive, HotspotProfile, HotspotUser, VoucherRow } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRouters } from '@/lib/queries';
import { useConfirm, useToast } from '@/lib/toast';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Page,
  PageBody,
  PageHeader,
  Select,
  Tabs,
  TextInput,
} from '@/components/ui';

type Tab = 'users' | 'profiles' | 'active' | 'vouchers';

const HOTSPOT_TABS: { value: Tab; label: string }[] = [
  { value: 'users', label: 'Users' },
  { value: 'profiles', label: 'Profiles' },
  { value: 'active', label: 'Active' },
  { value: 'vouchers', label: 'Vouchers' },
];

function downloadCsv(rows: VoucherRow[]) {
  const csv = [
    'username,password,profile',
    ...rows.map((r) => `${r.username},${r.password},${r.profile ?? ''}`),
  ].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vouchers.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse a number input, clamping into [min,max]; empty/NaN falls back to min. */
const clampInt = (v: string, min: number, max: number): number => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};

/** Humanize a raw byte count (RouterOS returns strings) into B/KB/MB/GB/TB. */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function formatBytes(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / 1024 ** i;
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${UNITS[i]}`;
}

export default function HotspotPage() {
  const { can } = useAuth();
  const routers = useRouters();
  const qc = useQueryClient();
  const [routerId, setRouterId] = useState('');
  const [tab, setTab] = useState<Tab>('users');

  const canView = can('hotspot:view');
  const canManage = can('hotspot:manage-users');
  const canManageProfiles = can('hotspot:manage-profiles');
  const canDisconnect = can('hotspot:disconnect');
  const toast = useToast();
  const confirm = useConfirm();

  const rid = routerId || routers.data?.[0]?.id || '';

  const users = useQuery({
    queryKey: ['hotspot', rid, 'users'],
    queryFn: () => api.get<HotspotUser[]>(`/hotspot/${rid}/users`),
    enabled: Boolean(rid) && canView && tab === 'users',
  });
  const profiles = useQuery({
    queryKey: ['hotspot', rid, 'profiles'],
    queryFn: () => api.get<HotspotProfile[]>(`/hotspot/${rid}/profiles`),
    // profiles feed the dropdowns on the users/vouchers tabs too
    enabled: Boolean(rid) && canView && tab !== 'active',
  });
  const sessions = useQuery({
    queryKey: ['hotspot', rid, 'active'],
    queryFn: () => api.get<HotspotActive[]>(`/hotspot/${rid}/active`),
    enabled: Boolean(rid) && canView && tab === 'active',
  });

  const invalidateUsers = () => qc.invalidateQueries({ queryKey: ['hotspot', rid, 'users'] });
  const invalidateProfiles = () => qc.invalidateQueries({ queryKey: ['hotspot', rid, 'profiles'] });

  // ---- user state + mutations ----
  const [newUser, setNewUser] = useState({ name: '', password: '', profile: '' });
  const [editUser, setEditUser] = useState<
    { id: string; profile: string; password: string; comment: string } | null
  >(null);

  const createUser = useMutation({
    mutationFn: (body: { name: string; password?: string; profile?: string }) =>
      api.post(`/hotspot/${rid}/users`, body),
    onSuccess: () => {
      setNewUser({ name: '', password: '', profile: '' });
      invalidateUsers();
    },
  });
  const updateUser = useMutation({
    mutationFn: (body: { id: string; profile?: string; password?: string; comment?: string }) =>
      api.post(`/hotspot/${rid}/users/update`, body),
    onSuccess: () => {
      setEditUser(null);
      invalidateUsers();
    },
  });
  const deleteUser = useMutation({
    mutationFn: (id: string) => api.post(`/hotspot/${rid}/users/delete`, { id }),
    onSuccess: () => { toast.ok('User dihapus'); invalidateUsers(); },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const askDeleteUser = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Hapus hotspot user?',
      body: `${name} akan dihapus dari MikroTik.`,
      confirmLabel: 'Hapus',
      danger: true,
    });
    if (ok) deleteUser.mutate(id);
  };
  const disconnect = useMutation({
    mutationFn: (id: string) => api.post(`/hotspot/${rid}/active/disconnect`, { id }),
    onSuccess: () => { toast.ok('Session ditutup'); qc.invalidateQueries({ queryKey: ['hotspot', rid, 'active'] }); },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  // ---- profile state + mutations ----
  const emptyProfile = { name: '', rateLimit: '', sharedUsers: '', sessionTimeout: '' };
  const [newProfile, setNewProfile] = useState(emptyProfile);
  const [editProfile, setEditProfile] = useState<(typeof emptyProfile & { id: string }) | null>(null);
  const upsertProfile = useMutation({
    mutationFn: (body: Record<string, string | undefined>) =>
      api.post(`/hotspot/${rid}/profiles`, body),
    onSuccess: () => {
      setNewProfile(emptyProfile);
      setEditProfile(null);
      invalidateProfiles();
    },
  });

  // ---- vouchers ----
  const [voucher, setVoucher] = useState({
    count: 10,
    prefix: '',
    profile: '',
    usernameLength: 6,
    passwordLength: 6,
    sameAsUsername: false,
  });
  const [voucherRows, setVoucherRows] = useState<VoucherRow[]>([]);
  const genVouchers = useMutation({
    mutationFn: () => api.post<{ vouchers: VoucherRow[] }>(`/hotspot/${rid}/vouchers`, voucher),
    onSuccess: (d) => setVoucherRows(d.vouchers),
  });

  if (!canView)
    return (
      <Page>
        <PageHeader title="Hotspot" />
        <PageBody>
          <EmptyState>You do not have access to hotspot management.</EmptyState>
        </PageBody>
      </Page>
    );

  const profileNames = profiles.data?.map((p) => p.name) ?? [];
  const profileSelect = (value: string, onChange: (v: string) => void) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— default —</option>
      {profileNames.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </Select>
  );

  return (
    <Page>
      <PageHeader
        title="Hotspot"
        subtitle="Kelola user, profil, sesi aktif, dan voucher."
        actions={<Tabs tabs={HOTSPOT_TABS} value={tab} onChange={setTab} />}
      />
      <PageBody>
        <div className="max-w-xs">
        <Field label="Router">
          <Select value={rid} onChange={(e) => setRouterId(e.target.value)}>
            {routers.data?.length ? (
              routers.data.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.host})
                </option>
              ))
            ) : (
              <option value="">No routers available</option>
            )}
          </Select>
        </Field>
        </div>

      {/* ---------------- USERS ---------------- */}
      {tab === 'users' && (
        <Card className="p-4">
          {canManage && (
            <div className="mb-4 flex flex-wrap items-end gap-2">
              <Field label="Name">
                <TextInput
                  value={newUser.name}
                  onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                />
              </Field>
              <Field label="Password">
                <TextInput
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
              </Field>
              <Field label="Profile">
                {profileSelect(newUser.profile, (v) => setNewUser({ ...newUser, profile: v }))}
              </Field>
              <Button
                onClick={() =>
                  createUser.mutate({
                    name: newUser.name,
                    password: newUser.password || undefined,
                    profile: newUser.profile || undefined,
                  })
                }
                disabled={!newUser.name || createUser.isPending}
              >
                Add user
              </Button>
            </div>
          )}
          {users.isError ? (
            <ErrorState onRetry={() => void users.refetch()}>
              Gagal memuat user — router mungkin tak terjangkau.
            </ErrorState>
          ) : users.isLoading ? (
            <Loading />
          ) : (
            <div className="overflow-x-auto">
              <table className="r-table w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1">Name</th>
                    <th>Profile</th>
                    <th>Uptime</th>
                    <th>Traffic (in/out)</th>
                    {canManage && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {users.data?.map((u) => (
                    <Fragment key={u['.id'] ?? u.name}>
                      <tr className="border-t border-surface-border">
                        <td data-label="Name" className="py-1.5">{u.name}</td>
                        <td data-label="Profile">{u.profile}</td>
                        <td data-label="Uptime">{u.uptime}</td>
                        <td data-label="Traffic">
                          {formatBytes(u['bytes-in'])} / {formatBytes(u['bytes-out'])}
                        </td>
                        {canManage && (
                          <td className="space-x-3 py-1.5 text-right">
                            <button
                              className="text-accent hover:opacity-80"
                              onClick={() =>
                                u['.id'] &&
                                setEditUser({
                                  id: u['.id'],
                                  profile: u.profile ?? '',
                                  password: '',
                                  comment: u.comment ?? '',
                                })
                              }
                            >
                              edit
                            </button>
                            <button
                              className="text-red-400 hover:text-red-300"
                              onClick={() => u['.id'] && askDeleteUser(u['.id'], u.name)}
                            >
                              delete
                            </button>
                          </td>
                        )}
                      </tr>
                      {editUser && editUser.id === u['.id'] && (
                        <tr className="border-t border-surface-border bg-surface">
                          <td colSpan={5} className="p-3">
                            <div className="flex flex-wrap items-end gap-2">
                              <Field label="Profile">
                                {profileSelect(editUser.profile, (v) =>
                                  setEditUser((p) => (p ? { ...p, profile: v } : p)),
                                )}
                              </Field>
                              <Field label="New password">
                                <TextInput
                                  placeholder="(unchanged)"
                                  value={editUser.password}
                                  onChange={(e) =>
                                    setEditUser((p) => (p ? { ...p, password: e.target.value } : p))
                                  }
                                />
                              </Field>
                              <Field label="Comment">
                                <TextInput
                                  value={editUser.comment}
                                  onChange={(e) =>
                                    setEditUser((p) => (p ? { ...p, comment: e.target.value } : p))
                                  }
                                />
                              </Field>
                              <Button
                                onClick={() => {
                                  if (!editUser) return;
                                  updateUser.mutate({
                                    id: editUser.id,
                                    profile: editUser.profile || undefined,
                                    password: editUser.password || undefined,
                                    comment: editUser.comment || undefined,
                                  });
                                }}
                                disabled={updateUser.isPending}
                              >
                                Save
                              </Button>
                              <Button variant="ghost" onClick={() => setEditUser(null)}>
                                Cancel
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {users.data?.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-slate-500">
                        No hotspot users on this router.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---------------- PROFILES ---------------- */}
      {tab === 'profiles' && (
        <Card className="p-4">
          {canManageProfiles ? (
            <div className="mb-4 flex flex-wrap items-end gap-2">
              <Field label="Name">
                <TextInput
                  value={newProfile.name}
                  onChange={(e) => setNewProfile({ ...newProfile, name: e.target.value })}
                  className="w-32"
                />
              </Field>
              <Field label="Rate limit">
                <TextInput
                  placeholder="2M/2M"
                  value={newProfile.rateLimit}
                  onChange={(e) => setNewProfile({ ...newProfile, rateLimit: e.target.value })}
                  className="w-28"
                />
              </Field>
              <Field label="Shared users">
                <TextInput
                  placeholder="1"
                  value={newProfile.sharedUsers}
                  onChange={(e) => setNewProfile({ ...newProfile, sharedUsers: e.target.value })}
                  className="w-24"
                />
              </Field>
              <Field label="Session timeout">
                <TextInput
                  placeholder="1h"
                  value={newProfile.sessionTimeout}
                  onChange={(e) => setNewProfile({ ...newProfile, sessionTimeout: e.target.value })}
                  className="w-24"
                />
              </Field>
              <Button
                onClick={() =>
                  upsertProfile.mutate({
                    name: newProfile.name,
                    rateLimit: newProfile.rateLimit || undefined,
                    sharedUsers: newProfile.sharedUsers || undefined,
                    sessionTimeout: newProfile.sessionTimeout || undefined,
                  })
                }
                disabled={!newProfile.name || upsertProfile.isPending}
              >
                Add profile
              </Button>
            </div>
          ) : (
            <p className="mb-3 text-xs text-slate-500">Read-only — you cannot manage profiles.</p>
          )}
          {profiles.isError ? (
            <ErrorState onRetry={() => void profiles.refetch()}>
              Gagal memuat profil — router mungkin tak terjangkau.
            </ErrorState>
          ) : profiles.isLoading ? (
            <Loading />
          ) : (
            <div className="overflow-x-auto">
              <table className="r-table w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-1">Name</th>
                    <th>Rate limit</th>
                    <th>Shared</th>
                    <th>Session timeout</th>
                    {canManageProfiles && <th className="text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {profiles.data?.map((p) => (
                    <Fragment key={p['.id'] ?? p.name}>
                      <tr className="border-t border-surface-border">
                        <td data-label="Name" className="py-1.5">{p.name}</td>
                        <td data-label="Rate limit">{p['rate-limit'] ?? '—'}</td>
                        <td data-label="Shared">{p['shared-users'] ?? '—'}</td>
                        <td data-label="Session timeout">{p['session-timeout'] ?? '—'}</td>
                        {canManageProfiles && (
                          <td className="py-1.5 text-right">
                            <button
                              className="text-accent hover:opacity-80"
                              onClick={() =>
                                p['.id'] &&
                                setEditProfile({
                                  id: p['.id'],
                                  name: p.name,
                                  rateLimit: p['rate-limit'] ?? '',
                                  sharedUsers: p['shared-users'] ?? '',
                                  sessionTimeout: p['session-timeout'] ?? '',
                                })
                              }
                            >
                              edit
                            </button>
                          </td>
                        )}
                      </tr>
                      {editProfile && editProfile.id === p['.id'] && (
                        <tr className="border-t border-surface-border bg-surface">
                          <td colSpan={5} className="p-3">
                            <div className="flex flex-wrap items-end gap-2">
                              <Field label="Rate limit">
                                <TextInput
                                  value={editProfile.rateLimit}
                                  onChange={(e) =>
                                    setEditProfile((p) =>
                                      p ? { ...p, rateLimit: e.target.value } : p,
                                    )
                                  }
                                  className="w-28"
                                />
                              </Field>
                              <Field label="Shared users">
                                <TextInput
                                  value={editProfile.sharedUsers}
                                  onChange={(e) =>
                                    setEditProfile((p) =>
                                      p ? { ...p, sharedUsers: e.target.value } : p,
                                    )
                                  }
                                  className="w-24"
                                />
                              </Field>
                              <Field label="Session timeout">
                                <TextInput
                                  value={editProfile.sessionTimeout}
                                  onChange={(e) =>
                                    setEditProfile((p) =>
                                      p ? { ...p, sessionTimeout: e.target.value } : p,
                                    )
                                  }
                                  className="w-24"
                                />
                              </Field>
                              <Button
                                onClick={() => {
                                  if (!editProfile) return;
                                  upsertProfile.mutate({
                                    id: editProfile.id,
                                    name: editProfile.name,
                                    rateLimit: editProfile.rateLimit || undefined,
                                    sharedUsers: editProfile.sharedUsers || undefined,
                                    sessionTimeout: editProfile.sessionTimeout || undefined,
                                  });
                                }}
                                disabled={upsertProfile.isPending}
                              >
                                Save
                              </Button>
                              <Button variant="ghost" onClick={() => setEditProfile(null)}>
                                Cancel
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {profiles.data?.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-slate-500">
                        No profiles on this router.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ---------------- ACTIVE ---------------- */}
      {tab === 'active' && (
        <Card className="p-4">
          {sessions.isError ? (
            <ErrorState onRetry={() => void sessions.refetch()}>
              Gagal memuat sesi — router mungkin tak terjangkau.
            </ErrorState>
          ) : sessions.isLoading ? (
            <Loading />
          ) : (
            <>
              {(() => {
                const rows = sessions.data ?? [];
                const totIn = rows.reduce((n, a) => n + (Number(a['bytes-in']) || 0), 0);
                const totOut = rows.reduce((n, a) => n + (Number(a['bytes-out']) || 0), 0);
                return (
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone="accent">{rows.length} sesi aktif</Badge>
                    <Badge tone="sky">↓ {formatBytes(totIn)} masuk</Badge>
                    <Badge tone="emerald">↑ {formatBytes(totOut)} keluar</Badge>
                  </div>
                );
              })()}
              <div className="overflow-x-auto">
                <table className="r-table w-full text-sm">
                  <thead className="text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-1">User</th>
                      <th>Address</th>
                      <th>MAC</th>
                      <th>Uptime</th>
                      <th>Idle</th>
                      <th>Traffic (↓in / ↑out)</th>
                      {canDisconnect && <th className="text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.data?.map((a) => (
                      <tr key={a['.id'] ?? a.address} className="border-t border-surface-border">
                        <td data-label="User" className="py-1.5">
                          <div>
                            <div className="font-medium text-slate-200">{a.user}</div>
                            {a['login-by'] && (
                              <div className="text-[10px] text-slate-500">via {a['login-by']}</div>
                            )}
                          </div>
                        </td>
                        <td data-label="Address" className="font-mono text-xs">{a.address}</td>
                        <td data-label="MAC" className="font-mono text-xs">{a['mac-address']}</td>
                        <td data-label="Uptime">
                          <div>
                            <div>{a.uptime}</div>
                            {a['session-time-left'] && (
                              <div className="text-[10px] text-slate-500">sisa {a['session-time-left']}</div>
                            )}
                          </div>
                        </td>
                        <td data-label="Idle" className="text-slate-400">{a['idle-time'] ?? '—'}</td>
                        <td data-label="Traffic">
                          <span className="whitespace-nowrap">
                            <span className="text-sky-600 dark:text-sky-400">↓ {formatBytes(a['bytes-in'])}</span>
                            <span className="mx-1 text-slate-500">/</span>
                            <span className="text-emerald-600 dark:text-emerald-400">↑ {formatBytes(a['bytes-out'])}</span>
                          </span>
                        </td>
                        {canDisconnect && (
                          <td className="py-1.5 text-right">
                            <button
                              className="text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                              onClick={() => a['.id'] && disconnect.mutate(a['.id'])}
                            >
                              disconnect
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                    {sessions.data?.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-3 text-slate-500">
                          No active sessions.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {/* ---------------- VOUCHERS ---------------- */}
      {tab === 'vouchers' && (
        <Card className="p-4">
          {!canManage ? (
            <p className="text-slate-400">You cannot generate vouchers.</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-end gap-2">
                <Field label="Count">
                  <TextInput
                    type="number"
                    min={1}
                    max={1000}
                    value={voucher.count}
                    onChange={(e) =>
                      setVoucher({ ...voucher, count: clampInt(e.target.value, 1, 1000) })
                    }
                    className="w-20"
                  />
                </Field>
                <Field label="Prefix">
                  <TextInput
                    value={voucher.prefix}
                    onChange={(e) => setVoucher({ ...voucher, prefix: e.target.value })}
                    className="w-24"
                  />
                </Field>
                <Field label="Profile">
                  {profileSelect(voucher.profile, (v) => setVoucher({ ...voucher, profile: v }))}
                </Field>
                <Field label="User len">
                  <TextInput
                    type="number"
                    min={3}
                    max={24}
                    value={voucher.usernameLength}
                    onChange={(e) =>
                      setVoucher({ ...voucher, usernameLength: clampInt(e.target.value, 3, 24) })
                    }
                    className="w-16"
                  />
                </Field>
                <Field label="Pass len">
                  <TextInput
                    type="number"
                    min={3}
                    max={24}
                    value={voucher.passwordLength}
                    onChange={(e) =>
                      setVoucher({ ...voucher, passwordLength: clampInt(e.target.value, 3, 24) })
                    }
                    className="w-16"
                    disabled={voucher.sameAsUsername}
                  />
                </Field>
                <label className="flex items-center gap-1.5 pb-1.5 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={voucher.sameAsUsername}
                    onChange={(e) => setVoucher({ ...voucher, sameAsUsername: e.target.checked })}
                  />
                  pass = user
                </label>
                <Button onClick={() => genVouchers.mutate()} disabled={genVouchers.isPending}>
                  {genVouchers.isPending ? 'Generating…' : 'Generate'}
                </Button>
                {voucherRows.length > 0 && (
                  <Button variant="secondary" onClick={() => downloadCsv(voucherRows)}>
                    Export CSV
                  </Button>
                )}
              </div>
              {genVouchers.isError && (
                <p className="mb-3 text-sm text-red-400">{(genVouchers.error as Error).message}</p>
              )}
              {voucherRows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="r-table w-full text-sm">
                    <thead className="text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="py-1">Username</th>
                        <th>Password</th>
                        <th>Profile</th>
                      </tr>
                    </thead>
                    <tbody>
                      {voucherRows.map((v) => (
                        <tr key={v.username} className="border-t border-surface-border">
                          <td data-label="Username" className="py-1.5">{v.username}</td>
                          <td data-label="Password">{v.password}</td>
                          <td data-label="Profile">{v.profile ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Card>
      )}
      </PageBody>
    </Page>
  );
}
