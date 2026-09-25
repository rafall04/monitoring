'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
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
        <p className="text-2xs text-slate-500">
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
          <span className="ml-3 text-2xs text-slate-500">
            Setelah berhasil, semua session aktif di device lain akan logout.
          </span>
        </div>
      </Card>

      {/* ---- WhatsApp link ---- */}
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-slate-200">WhatsApp</h2>
        <WaLinkSection />
      </Card>
      </PageBody>
    </Page>
  );
}

/** Link a staff number so the bot recognizes SITES/DOWN/ACK/PING/etc. */
function WaLinkSection() {
  const toast = useToast();
  const wa = useQuery({
    queryKey: ['me', 'wa'],
    queryFn: () => api.get<{ phone: string | null; phoneVerified: boolean }>('/me/wa'),
  });
  const [code, setCode] = useState<{ code: string; ttlSec: number } | null>(null);
  const genCode = useMutation({
    mutationFn: () => api.post<{ code: string; ttlSec: number }>('/me/wa/link-code', {}),
    onSuccess: setCode,
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const d = wa.data;
  if (d?.phoneVerified && d.phone) {
    return (
      <p className="text-sm text-slate-300">
        ✅ Nomor <span className="font-mono">{d.phone}</span> tertaut — perintah bot aktif
        (SITES, DOWN, ACK, PING, TIKET, LAPORAN, PROSES/SELESAI).
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-slate-500">
        Tautkan nomor WA Anda untuk memakai perintah bot NOC (cek status site, ack insiden,
        kerjakan tiket). Ambil kode lalu kirim <code className="font-mono">LINK &lt;kode&gt;</code>{' '}
        ke nomor bot.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => genCode.mutate()} disabled={genCode.isPending}>
          {genCode.isPending ? 'Membuat…' : 'Buat kode link'}
        </Button>
        {code && (
          <span className="text-sm">
            Kode: <span className="font-mono text-lg font-bold text-accent">{code.code}</span>
            <span className="ml-2 text-xs text-slate-500">
              berlaku {Math.round(code.ttlSec / 60)} menit
            </span>
          </span>
        )}
      </div>
      {d?.phone && !d.phoneVerified && (
        <p className="text-xs text-amber-400">
          Nomor {d.phone} tercatat tapi belum terverifikasi — kirim LINK dari nomor itu.
        </p>
      )}
    </>
  );
}
