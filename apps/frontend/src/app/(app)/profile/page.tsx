'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { AppUserPublic } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import { Button, Card, Field, Loading, Page, PageBody, PageHeader, TextInput } from '@/components/ui';

export default function ProfilePage() {
  const { user, setUser } = useAuth();
  const toast = useToast();

  const [name, setName] = useState(user?.name ?? '');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });

  const saveProfile = useMutation({
    mutationFn: () => api.patch<AppUserPublic>('/auth/me', { name }),
    onSuccess: (u) => {
      setUser(u);
      toast.ok('Profil tersimpan');
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  const changePw = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword: pw.current,
        newPassword: pw.next,
      }),
    onSuccess: () => {
      setPw({ current: '', next: '', confirm: '' });
      toast.ok('Password diubah. Session di device lain akan otomatis logout.');
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  if (!user) {
    return (
      <Page>
        <PageHeader title="My profile" />
        <PageBody>
          <Loading />
        </PageBody>
      </Page>
    );
  }

  const pwMismatch = pw.next.length > 0 && pw.next !== pw.confirm;
  const pwTooShort = pw.next.length > 0 && pw.next.length < 8;
  const canChangePw = !!pw.current && pw.next.length >= 8 && !pwMismatch;

  return (
    <Page>
      <PageHeader title="My profile" subtitle="Kelola identitas dan password akun Anda." />
      <PageBody>
        {/* ---- Identity ---- */}
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-slate-200">Identitas</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Nama">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email">
            <TextInput value={user.email} disabled />
          </Field>
          <Field label="Role">
            <TextInput value={user.role} disabled />
          </Field>
        </div>
        <p className="text-[11px] text-slate-500">
          Email + role hanya bisa diubah oleh super_admin (mencegah lock-out).
        </p>
        <div>
          <Button
            onClick={() => saveProfile.mutate()}
            disabled={saveProfile.isPending || !name || name === user.name}
          >
            {saveProfile.isPending ? 'Menyimpan…' : 'Simpan'}
          </Button>
        </div>
      </Card>

      {/* ---- Password ---- */}
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-slate-200">Ubah password</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Password sekarang">
            <TextInput
              type="password"
              autoComplete="current-password"
              value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })}
            />
          </Field>
          <Field label="Password baru (min. 8)">
            <TextInput
              type="password"
              autoComplete="new-password"
              value={pw.next}
              onChange={(e) => setPw({ ...pw, next: e.target.value })}
            />
          </Field>
          <Field label="Ulangi password baru">
            <TextInput
              type="password"
              autoComplete="new-password"
              value={pw.confirm}
              onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
            />
          </Field>
        </div>
        {pwTooShort && <p className="text-xs text-amber-400">Password baru minimal 8 karakter.</p>}
        {pwMismatch && <p className="text-xs text-amber-400">Konfirmasi password belum sama.</p>}
        <div>
          <Button onClick={() => changePw.mutate()} disabled={changePw.isPending || !canChangePw}>
            {changePw.isPending ? 'Mengubah…' : 'Ubah password'}
          </Button>
          <span className="ml-3 text-[11px] text-slate-500">
            Setelah berhasil, semua session aktif di device lain akan logout.
          </span>
        </div>
      </Card>
      </PageBody>
    </Page>
  );
}
