'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { MemberHotspotStatus } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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
  TABLE,
  TextInput,
} from '@/components/ui';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function formatBytes(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / 1024 ** i;
  return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${UNITS[i]}`;
}

/**
 * Member self-service ("Akun Saya"): the hotspot account owner sees their own
 * quota/sessions, rotates their own password, and kicks stale sessions — the
 * fixes that used to need an operator.
 */
export default function AkunPage() {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();

  const status = useQuery({
    queryKey: ['me', 'hotspot'],
    queryFn: () => api.get<MemberHotspotStatus>('/me/hotspot'),
    refetchInterval: 30_000,
    retry: false,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['me', 'hotspot'] });

  const kick = useMutation({
    mutationFn: (id?: string) => api.post<{ kicked: number }>('/me/hotspot/kick', id ? { id } : {}),
    onSuccess: (d) => {
      toast.ok(`${d.kicked} sesi diputus`);
      refresh();
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const askKickAll = async () => {
    const ok = await confirm({
      title: 'Putuskan semua sesi?',
      body: 'Semua perangkat yang sedang login dengan akun Anda akan logout dari WiFi.',
      confirmLabel: 'Putuskan semua',
      danger: true,
    });
    if (ok) kick.mutate(undefined);
  };

  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const changePw = useMutation({
    mutationFn: () =>
      api.post('/me/hotspot/password', {
        currentPassword: pw.current,
        newPassword: pw.next,
      }),
    onSuccess: () => {
      toast.ok('Password diganti — semua sesi login diputus. Gunakan password baru untuk login WiFi & halaman ini');
      setPw({ current: '', next: '', confirm: '' });
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const submitPw = () => {
    if (pw.next !== pw.confirm) {
      toast.error('Konfirmasi password baru tidak sama');
      return;
    }
    changePw.mutate();
  };

  const d = status.data;

  return (
    <Page>
      <PageHeader
        title="Akun Hotspot Saya"
        subtitle={`Halo, ${user?.name ?? ''} — kelola akun WiFi Anda sendiri.`}
      />
      <PageBody>
        {status.isError ? (
          <ErrorState onRetry={() => void status.refetch()}>
            {(status.error as Error)?.message?.includes('tidak tertaut')
              ? 'Akun ini belum tertaut ke akun hotspot. Chat bot WA IT: 0851-3750-1184.'
              : 'Gagal memuat status akun — router mungkin tidak terjangkau.'}
          </ErrorState>
        ) : status.isLoading || !d ? (
          <Loading />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* ---- Identitas & status ---- */}
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">Akun WiFi</h3>
                <Badge tone={d.disabled ? 'red' : 'emerald'}>
                  {d.disabled ? 'Nonaktif' : 'Aktif'}
                </Badge>
              </div>
              <dl className="space-y-2 text-sm">
                <Row k="Username" v={<span className="font-mono">{d.username}</span>} />
                <Row k="Profil akses" v={<Badge tone="accent">{d.profile}</Badge>} />
                <Row k="Perangkat bersamaan" v={`${d.devices}`} />
                <Row
                  k="Waktu terpakai"
                  v={d.limitUptime ? `${d.uptime ?? '0s'} / ${d.limitUptime}` : (d.uptime ?? '0s')}
                />
                <Row
                  k="Data terpakai"
                  v={
                    d.limitBytesTotal
                      ? `${formatBytes(
                          (Number(d.bytesIn) || 0) + (Number(d.bytesOut) || 0),
                        )} / ${formatBytes(d.limitBytesTotal)}`
                      : formatBytes((Number(d.bytesIn) || 0) + (Number(d.bytesOut) || 0))
                  }
                />
              </dl>
              {d.limitUptime || d.limitBytesTotal ? (
                <p className="mt-3 text-xs text-slate-500">
                  Limit habis → chat{' '}
                  <a
                    href="https://wa.me/6285137501184"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-cyan-400 underline underline-offset-2"
                  >
                    bot WA IT (0851-3750-1184)
                  </a>{' '}
                  untuk reset.
                </p>
              ) : null}
            </Card>

            {/* ---- Akses aplikasi ---- */}
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Akses Aplikasi</h3>
              {d.blockedServices.length === 0 ? (
                <p className="text-sm text-slate-400">
                  Tidak ada aplikasi yang diblokir untuk akun Anda.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-slate-500">
                    Aplikasi berikut <b>diblokir</b> sesuai kebutuhan kerja Anda — selain ini bebas:
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {d.blockedServices.map((s) => (
                      <Badge key={s.key} tone="red">
                        {s.label}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    Butuh aplikasi yang diblokir? Minta penambahan akses ke{' '}
                    <a
                      href="https://wa.me/6285137501184"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-cyan-400 underline underline-offset-2"
                    >
                      bot WA IT (0851-3750-1184)
                    </a>
                    .
                  </p>
                </>
              )}
            </Card>

            {/* ---- Perangkat / sesi aktif ---- */}
            <Card className="p-4 lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">
                  Perangkat Aktif ({d.sessions.length}/{d.devices})
                </h3>
                {d.sessions.length > 0 && (
                  <Button variant="ghost" onClick={() => void askKickAll()}>
                    Putuskan semua
                  </Button>
                )}
              </div>
              {d.sessions.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Tidak ada sesi aktif. Kalau login gagal karena &quot;sedang dipakai di perangkat
                  lain&quot;, sesi lama mungkin masih tercatat — coba lagi sebentar, atau tombol ini
                  akan muncul saat ada sesi.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="r-table w-full text-sm">
                    <thead className={TABLE.head}>
                      <tr>
                        <th className={TABLE.thDense}>IP</th>
                        <th className={TABLE.thDense}>MAC</th>
                        <th className={TABLE.thDense}>Aktif</th>
                        <th className={TABLE.thDense}>Login via</th>
                        <th className={`${TABLE.thDense} text-right`}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.sessions.map((s) => (
                        <tr key={s['.id']} className="border-t border-surface-border">
                          <td data-label="IP" className={`${TABLE.tdDense} font-mono`}>
                            {s.address}
                          </td>
                          <td data-label="MAC" className={`${TABLE.tdDense} font-mono`}>
                            {s['mac-address']}
                          </td>
                          <td data-label="Aktif" className={TABLE.tdDense}>
                            {s.uptime}
                          </td>
                          <td data-label="Login via" className={TABLE.tdDense}>
                            {s['login-by']}
                          </td>
                          <td className={`${TABLE.tdDense} text-right`}>
                            <button
                              className="noc-tap inline-flex items-center text-red-400 hover:text-red-300"
                              onClick={() => s['.id'] && kick.mutate(s['.id'])}
                            >
                              putuskan
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* ---- Ganti password ---- */}
            <Card className="p-4 lg:col-span-2">
              <h3 className="mb-3 text-sm font-semibold text-slate-200">Ganti Password</h3>
              <p className="mb-3 text-xs text-slate-500">
                Password ini dipakai untuk login WiFi <b>dan</b> halaman ini — keduanya ikut berubah.
                Semua sesi akan logout — silakan login ulang dengan password baru.
              </p>
              <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-3">
                <Field label="Password lama">
                  <TextInput
                    type="password"
                    value={pw.current}
                    onChange={(e) => setPw({ ...pw, current: e.target.value })}
                  />
                </Field>
                <Field label="Password baru">
                  <TextInput
                    type="password"
                    value={pw.next}
                    onChange={(e) => setPw({ ...pw, next: e.target.value })}
                  />
                </Field>
                <Field label="Ulangi password baru">
                  <TextInput
                    type="password"
                    value={pw.confirm}
                    onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
                  />
                </Field>
              </div>
              <Button
                className="mt-3"
                onClick={submitPw}
                disabled={!pw.current || !pw.next || changePw.isPending}
              >
                {changePw.isPending ? 'Menyimpan…' : 'Simpan password baru'}
              </Button>
            </Card>
          </div>
        )}
      </PageBody>
    </Page>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right text-slate-200">{v}</dd>
    </div>
  );
}
