'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AppUserPublic, MemberHotspotStatus, Ticket, TicketStatus } from '@noc/shared';
import { TICKET_CATEGORIES } from '@noc/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { liteInterval } from '@/lib/lite';
import { useConfirm, useToast } from '@/lib/toast';
import {
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Page,
  PageBody,
  PageHeader,
  Select,
  TABLE,
  Textarea,
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
    refetchInterval: liteInterval(30_000),
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
          </div>
        )}

        {/* Account-level cards — deliberately OUTSIDE the hotspot-status
            conditional, so a member can still complain/link/manage their
            account exactly when the router is unreachable. */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ---- Komplain (web twin of the bot's KOMPLAIN) ---- */}
          <ComplaintCard user={user} />

          {/* ---- WhatsApp link ---- */}
          <WaLinkCard />

          {/* ---- Riwayat komplain sendiri ---- */}
          <MyTicketsCard />

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
      </PageBody>
    </Page>
  );
}

const TICKET_STATUS_TONE: Record<TicketStatus, 'red' | 'amber' | 'emerald'> = {
  open: 'red',
  ack: 'amber',
  resolved: 'emerald',
};
const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  ack: 'Diproses',
  resolved: 'Selesai',
};
const TICKET_CATEGORY_LABEL: Record<string, string> = {
  gangguan: 'Gangguan / mati',
  lambat: 'Lambat',
  voucher: 'Voucher',
  lainnya: 'Lainnya',
};

function timeAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.floor(h / 24)} hari lalu`;
}

/**
 * Web twin of the bot's KOMPLAIN — the member files a complaint that lands on
 * the same ticket pipeline (same forwards to technicians). The department is
 * prefilled from the profile and, when newly set, is saved back — matching the
 * bot's ask-once behavior.
 */
function ComplaintCard({ user }: { user: AppUserPublic | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { setUser } = useAuth();
  const [dept, setDept] = useState(user?.department ?? '');
  const [category, setCategory] = useState<string>('gangguan');
  const [message, setMessage] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      api.post<Ticket>('/me/tickets', {
        message,
        category,
        department: dept.trim() || null,
      }),
    onSuccess: async (t) => {
      toast.ok(`Tiket #${t.id.slice(0, 6).toUpperCase()} terkirim ke teknisi`);
      setMessage('');
      void qc.invalidateQueries({ queryKey: ['me', 'tickets'] });
      // The endpoint persisted a first-time department — refresh the profile.
      api.get<AppUserPublic>('/auth/me').then(setUser).catch(() => undefined);
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-semibold text-slate-200">Komplain / Laporan</h3>
      <p className="mb-3 text-xs text-slate-500">
        Gangguan WiFi? Laporkan di sini — langsung diteruskan ke teknisi site Anda lewat WhatsApp.
        Bisa juga lewat chat bot: kirim <code className="font-mono">KOMPLAIN &lt;pesan&gt;</code>.
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Departemen">
            <TextInput
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              placeholder="mis. Produksi, QC"
            />
          </Field>
          <Field label="Kategori">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {TICKET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {TICKET_CATEGORY_LABEL[c] ?? c}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Komplain">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder="Jelaskan kendalanya — mis. WiFi sering putus sejak pagi di area packing…"
          />
        </Field>
        <Button
          onClick={() => submit.mutate()}
          disabled={submit.isPending || message.trim().length < 5}
        >
          {submit.isPending ? 'Mengirim…' : 'Kirim komplain'}
        </Button>
      </div>
    </Card>
  );
}

/** The member's own complaint history — statuses update as technicians work. */
function MyTicketsCard() {
  const q = useQuery({
    queryKey: ['me', 'tickets'],
    queryFn: () => api.get<Ticket[]>('/me/tickets'),
    refetchInterval: liteInterval(30_000),
  });

  const columns: ReadonlyArray<Column<Ticket>> = [
    {
      key: 'code',
      header: 'Tiket',
      cell: (r) => (
        <span className="font-mono text-xs font-semibold text-slate-200">
          #{r.id.slice(0, 6).toUpperCase()}
        </span>
      ),
      className: 'w-20',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <Badge tone={TICKET_STATUS_TONE[r.status]}>{TICKET_STATUS_LABEL[r.status]}</Badge>,
    },
    {
      key: 'message',
      header: 'Komplain',
      cell: (r) => (
        <span className="block max-w-md truncate text-slate-300" title={r.message}>
          {r.message}
        </span>
      ),
    },
    {
      key: 'age',
      header: 'Umur',
      cell: (r) => (
        <div>
          <div className="text-slate-300">{timeAgo(r.createdAt)}</div>
          {r.handledBy && <div className="text-xs text-slate-500">oleh {r.handledBy}</div>}
        </div>
      ),
    },
  ];

  return (
    <div className="lg:col-span-2">
      <DataTable
        dense
        columns={columns}
        rows={q.data ?? []}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError}
        onRetry={() => void q.refetch()}
        empty="Belum ada komplain — form di atas langsung terhubung ke teknisi."
      />
      <p className="mt-1 px-1 text-2xs text-slate-500">
        Riwayat komplain Anda — status diperbarui saat teknisi memproses.
      </p>
    </div>
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

/** Link the member's WhatsApp number: generates a code they text to the bot. */
function WaLinkCard() {
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
  return (
    <Card className="p-4 lg:col-span-2">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">Hubungkan WhatsApp</h3>
      {d?.phoneVerified && d.phone ? (
        <p className="text-sm text-slate-300">
          ✅ Nomor <span className="font-mono">{d.phone}</span> sudah tertaut — Anda bisa kirim
          STATUS / LOGOUT / KOMPLAIN ke bot.
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-500">
            Tautkan nomor WA Anda untuk self-service lewat chat (cek kuota, logout sesi, komplain).
            Ambil kode di bawah, lalu kirim <code className="font-mono">LINK &lt;kode&gt;</code> ke
            nomor bot.
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
            <p className="mt-2 text-xs text-amber-400">
              Nomor {d.phone} tercatat tapi belum terverifikasi — kirim LINK dari nomor itu.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
