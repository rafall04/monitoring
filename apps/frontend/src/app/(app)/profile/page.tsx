'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AppUserPublic } from '@noc/shared';
import { api, getRefreshToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/lib/toast';
import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Page,
  PageBody,
  PageHeader,
  TextInput,
} from '@/components/ui';

interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export default function ProfilePage() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const isMember = user?.role === 'member';

  const [name, setName] = useState(user?.name ?? '');
  const [dept, setDept] = useState(user?.department ?? '');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });

  const saveProfile = useMutation({
    mutationFn: () =>
      api.patch<AppUserPublic>('/auth/me', { name, department: dept.trim() || null }),
    onSuccess: (u) => {
      setUser(u);
      toast.ok('Profil tersimpan');
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  // Members: the web password IS the hotspot WiFi password — it must go
  // through /me/hotspot/password which writes BOTH the router user and the
  // web hash. /auth/change-password would desync the two credentials.
  const changePw = useMutation({
    mutationFn: () =>
      api.post(isMember ? '/me/hotspot/password' : '/auth/change-password', {
        currentPassword: pw.current,
        newPassword: pw.next,
        // Keep this session alive: the backend revokes every refresh token
        // EXCEPT the one we post — staff stay signed in on this device.
        // (member/hotspot endpoint revokes all by design — full re-login.)
        ...(isMember ? {} : { refreshToken: getRefreshToken() ?? undefined }),
      }),
    onSuccess: () => {
      setPw({ current: '', next: '', confirm: '' });
      toast.ok(
        isMember
          ? 'Password diganti — semua sesi diputus. Gunakan password baru untuk WiFi & login ulang.'
          : 'Password diubah. Perangkat lain logout; sesi ini tetap aktif.',
      );
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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Nama">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Departemen">
            <TextInput
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              placeholder="mis. Produksi"
            />
          </Field>
          <Field label="Email">
            <TextInput value={user.email} disabled />
          </Field>
          <Field label="Role">
            <TextInput value={user.role} disabled />
          </Field>
        </div>
        <p className="text-2xs text-slate-500">
          Departemen tampil di tiket komplain Anda. Email + role hanya bisa diubah oleh super_admin
          (mencegah lock-out).
        </p>
        <div>
          <Button
            onClick={() => saveProfile.mutate()}
            disabled={
              saveProfile.isPending ||
              !name ||
              (name === user.name && dept === (user.department ?? ''))
            }
          >
            {saveProfile.isPending ? 'Menyimpan…' : 'Simpan'}
          </Button>
        </div>
      </Card>

      {/* ---- Password ---- */}
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-slate-200">Ubah password</h2>
        {isMember && (
          <p className="rounded-lg border border-accent/25 bg-accent/5 px-3 py-2 text-xs text-slate-300">
            Password akun ini <b>sekaligus password WiFi</b> Anda — satu kredensial untuk keduanya.
            Detail kuota & sesi hotspot ada di halaman{' '}
            <a href="/akun" className="font-medium text-accent underline underline-offset-2">
              Akun Saya
            </a>
            .
          </p>
        )}
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
            {isMember
              ? 'Semua sesi diputus — login ulang dengan password baru (berlaku juga untuk WiFi).'
              : 'Perangkat lain akan logout; sesi ini tetap aktif.'}
          </span>
        </div>
      </Card>

      {/* ---- Sesi login ---- */}
      <SessionsCard />

      {/* ---- WhatsApp link ---- */}
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-slate-200">WhatsApp</h2>
        <WaLinkSection isMember={isMember} />
      </Card>
      </PageBody>
    </Page>
  );
}

// ---- Sesi login -------------------------------------------------------------
// One row per live refresh token (one device/browser). No device label is
// stored — sessions are identified by waktu login. "Keluar dari perangkat
// lain" posts our own refresh token so THIS session is the sole survivor.

function SessionsCard() {
  const toast = useToast();
  const q = useQuery({
    queryKey: ['me', 'sessions'],
    queryFn: () => api.get<SessionRow[]>('/me/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/me/sessions/${id}`),
    onSuccess: () => {
      toast.ok('Sesi dicabut');
      void q.refetch();
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const revokeOthers = useMutation({
    mutationFn: () =>
      api.post<{ revoked: number }>('/me/sessions/revoke-others', {
        refreshToken: getRefreshToken(),
      }),
    onSuccess: (r) => {
      toast.ok(`${r.revoked} sesi lain dicabut — sesi ini tetap aktif`);
      void q.refetch();
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  const rows = q.data ?? [];
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-200">Sesi &amp; Perangkat</h2>
        <Badge tone="slate">{rows.length} aktif</Badge>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">Tidak ada sesi aktif.</p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {rows.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0 text-xs">
                <p className="text-slate-200">
                  Login{' '}
                  {new Date(s.createdAt).toLocaleString('id-ID', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
                <p className="text-2xs text-slate-500">
                  berlaku s/d{' '}
                  {new Date(s.expiresAt).toLocaleDateString('id-ID', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                </p>
              </div>
              <button
                className="noc-tap rounded-md px-2 py-1 text-2xs font-medium text-red-400 hover:bg-red-500/10"
                onClick={() => revoke.mutate(s.id)}
                disabled={revoke.isPending}
              >
                Cabut
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 1 && (
        <div className="border-t border-surface-border pt-3">
          <Button
            variant="ghost"
            className="text-red-400 hover:text-red-300"
            disabled={revokeOthers.isPending}
            onClick={() => {
              if (
                window.confirm(
                  'Cabut semua sesi lain?\nSemua perangkat lain akan diminta login ulang. Sesi ini tetap aktif.',
                )
              )
                revokeOthers.mutate();
            }}
          >
            {revokeOthers.isPending ? 'Mencabut…' : 'Keluar dari semua perangkat lain'}
          </Button>
        </div>
      )}
      <p className="text-2xs text-slate-500">
        Perangkat hilang/dipinjam? Cabut sesinya di sini — atau ganti password untuk memutus
        semuanya sekaligus.
      </p>
    </Card>
  );
}

/** Link a number so the bot recognizes the user's commands (role-dependent). */
function WaLinkSection({ isMember }: { isMember: boolean }) {
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
        (
        {isMember
          ? 'STATUS, TIKET, INFO, KOMPLAIN'
          : 'SITES, DOWN, ACK, PING, TIKET, LAPORAN, PROSES/SELESAI'}
        ).
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-slate-500">
        {isMember
          ? 'Tautkan nomor WA Anda agar bot mengenali Anda — cek kuota dengan STATUS, lacak komplain dengan TIKET.'
          : 'Tautkan nomor WA Anda untuk memakai perintah bot NOC (cek status site, ack insiden, kerjakan tiket).'}{' '}
        Ambil kode lalu kirim <code className="font-mono">LINK &lt;kode&gt;</code> ke nomor bot.
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
