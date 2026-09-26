'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  ALERT_PLACEHOLDERS,
  type Settings,
  type Site,
  type SiteContactRole,
  type WaGroupInfo,
  type WaRecipient,
  type WaRecipientKind,
  type WaSessionState,
  type WaSessionStatus,
} from '@noc/shared';
import { api } from '@/lib/api';
import { liteInterval } from '@/lib/lite';
import { useSites } from '@/lib/queries';
import { useToast } from '@/lib/toast';
import {
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  EmptyState,
  Field,
  Loading,
  Page,
  PageBody,
  PageHeader,
  SectionHeader,
  Select,
  Tabs,
  Textarea,
  TextInput,
  type Tone,
} from '@/components/ui';

// =============================================================================
// WhatsApp console — everything about the bot lives here (moved out of
// Settings): pairing/session lifecycle, bot config, per-site recipients
// (numbers AND groups), test sends and broadcasts.
// =============================================================================

const WA_STATUS_META: Record<WaSessionStatus, { label: string; tone: Tone }> = {
  connected:  { label: 'Terhubung',        tone: 'emerald' },
  qr:         { label: 'Menunggu scan QR', tone: 'amber' },
  connecting: { label: 'Menghubungkan…',   tone: 'amber' },
  offline:    { label: 'Offline',          tone: 'red' },
  disabled:   { label: 'Nonaktif',         tone: 'slate' },
};

function useWaSession() {
  return useQuery({
    queryKey: ['wa-session'],
    queryFn: () => api.get<WaSessionState>('/whatsapp/session'),
    // Always 4s — NOT liteInterval. Pairing QRs rotate server-side every ~20s;
    // lite mode's 60s+ poll would render dead refs the phone can't complete.
    refetchInterval: 4000,
  });
}

/** Groups the bot participates in — cached by wabot, refreshed on demand. */
function useWaGroups(connected: boolean) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['wa-groups'],
    queryFn: () => api.get<WaGroupInfo[]>('/whatsapp/groups'),
    refetchInterval: liteInterval(30_000),
  });
  // First connect transition → pull a fresh list (wabot publishes on connect).
  useEffect(() => {
    if (connected) void qc.invalidateQueries({ queryKey: ['wa-groups'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
  return q;
}

export default function AdminWhatsappPage() {
  const session = useWaSession();
  const meta = WA_STATUS_META[session.data?.status ?? 'offline'];
  return (
    <Page>
      <PageHeader
        title="WhatsApp Bot"
        subtitle="Alert jaringan · self-service hotspot · komplain → teknisi"
        actions={<Badge tone={meta.tone}>{meta.label}</Badge>}
      />
      <PageBody>
        <SessionCard session={session.data} />
        <RecipientsCard />
        <MessageLogCard />
        <BotSettingsCard />
        <TestBroadcastCard />
      </PageBody>
    </Page>
  );
}

// ---- Koneksi & sesi ----------------------------------------------------------

function SessionCard({ session: s }: { session: WaSessionState | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qrImg, setQrImg] = useState<string | null>(null);

  useEffect(() => {
    const qr = s?.qr;
    if (!qr) {
      setQrImg(null);
      return;
    }
    void QRCode.toDataURL(qr, { width: 200, margin: 1 })
      .then(setQrImg)
      .catch(() => setQrImg(null));
  }, [s?.qr]);

  const op = async (kind: 'reconnect' | 'logout') => {
    if (
      kind === 'logout' &&
      !window.confirm(
        'Putuskan sesi WhatsApp dan buat sesi baru?\n' +
          'Nomor yang sedang tertaut akan dilepas dan QR baru dibuat (untuk ganti nomor).',
      )
    )
      return;
    try {
      await api.post(`/whatsapp/${kind}`, {});
      toast.ok(kind === 'logout' ? 'Sesi direset — menunggu QR baru…' : 'Reconnect diminta…');
      void qc.invalidateQueries({ queryKey: ['wa-session'] });
    } catch (e) {
      toast.error(`Gagal: ${(e as Error).message}`);
    }
  };

  return (
    <Card className="p-4">
      <SectionHeader
        title="Koneksi & Sesi"
        tone={WA_STATUS_META[s?.status ?? 'offline'].tone}
        action={
          s?.updatedAt ? (
            <span className="text-2xs text-slate-500">
              update {new Date(s.updatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : undefined
        }
      />

      {s?.status === 'qr' && qrImg && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 p-4 sm:flex-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrImg} alt="QR pairing WhatsApp" className="w-44 shrink-0 rounded-lg bg-white p-2" />
          <div className="text-xs text-slate-400">
            <p className="font-medium text-slate-200">Pairing nomor bot</p>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
              <li>Buka WhatsApp di HP nomor dedikasi bot</li>
              <li>
                <em>Perangkat Tertaut</em> → <em>Tautkan Perangkat</em>
              </li>
              <li>Arahkan kamera ke QR di samping</li>
            </ol>
            <p className="mt-2 text-slate-500">QR diperbarui otomatis tiap ~20 detik — biarkan halaman ini terbuka.</p>
          </div>
        </div>
      )}

      {s?.status === 'connected' && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/25">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07a8.2 8.2 0 0 1-2.4-1.48 9 9 0 0 1-1.66-2.07c-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.9 1.22 3.1.15.2 2.1 3.2 5.1 4.49.71.3 1.27.49 1.7.63.72.23 1.37.2 1.88.12.58-.09 1.76-.72 2-1.42.25-.7.25-1.3.18-1.42-.08-.13-.28-.2-.58-.35zM12.04 2a9.9 9.9 0 0 0-8.4 15.15L2 22l4.97-1.6A9.93 9.93 0 1 0 12.04 2z" />
            </svg>
          </span>
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium text-slate-100">{s.name ?? 'WhatsApp'}</p>
            <p className="truncate text-xs text-slate-500">{s.phone ? `+${s.phone}` : 'nomor tidak diketahui'}</p>
          </div>
        </div>
      )}

      {(s?.status === 'offline' || s?.status === 'connecting') && (
        <p className="text-xs text-slate-500">
          {s.status === 'connecting'
            ? 'Menghubungkan ke WhatsApp…'
            : 'Socket belum terhubung — bot akan mencoba ulang otomatis (maks 60 detik).'}
        </p>
      )}
      {s?.status === 'disabled' && (
        <p className="text-xs text-slate-500">
          Bot dinonaktifkan (<code>WA_ENABLED=false</code>). Aktifkan di .env lalu restart service wabot.
        </p>
      )}
      {s?.error && s.status !== 'connected' && (
        <p className="mt-2 text-xs text-red-400">Terakhir: {s.error}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-surface-border pt-3">
        <Button variant="secondary" onClick={() => void op('reconnect')}>
          Reconnect
        </Button>
        <Button variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => void op('logout')}>
          Sesi baru / ganti nomor
        </Button>
        <span className="text-2xs text-slate-500">
          Reconnect = restart socket, sesi tetap · Sesi baru = lepas nomor, QR baru
        </span>
      </div>
    </Card>
  );
}

// ---- Penerima per site --------------------------------------------------------
// One site picker (Tabs) + a single DataTable — replaces the old per-site
// repeated blocks that made this section sprawl.

function RecipientsCard() {
  const sites = useSites();
  const [siteId, setSiteId] = useState('');
  const site = (sites.data ?? []).find((s) => s.id === siteId) ?? sites.data?.[0];

  return (
    <Card className="p-4">
      <SectionHeader title="Penerima Alert & Tiket" />
      {sites.isLoading && <Loading />}
      {sites.data && !site && <EmptyState>Belum ada site — buat dulu di Admin → Sites.</EmptyState>}
      {site && (
        <SiteRecipients
          site={site}
          sites={sites.data ?? []}
          siteId={site.id}
          onSiteChange={setSiteId}
        />
      )}
    </Card>
  );
}

/** Small pill toggle used for the alert/tiket/aktif columns. */
function FlagPill({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`noc-tap inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ring-1 transition ${
        on
          ? 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-400'
          : 'bg-slate-500/10 text-slate-500 ring-slate-500/20 hover:text-slate-400'
      }`}
    >
      {label}
    </button>
  );
}

function SiteRecipients({
  site,
  sites,
  siteId,
  onSiteChange,
}: {
  site: Site;
  sites: Site[];
  siteId: string;
  onSiteChange: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useWaSession();
  const groups = useWaGroups(session.data?.status === 'connected');
  const [form, setForm] = useState<{
    name: string;
    kind: WaRecipientKind;
    target: string;
    role: SiteContactRole;
  }>({ name: '', kind: 'number', target: '', role: 'technician' });

  const recipients = useQuery({
    queryKey: ['wa-recipients', site.id],
    queryFn: () => api.get<WaRecipient[]>(`/sites/${site.id}/recipients`),
  });

  // Ask wabot to re-fetch its group list; it publishes to Redis ~1-2s later.
  const refreshGroups = useMutation({
    mutationFn: () => api.post('/whatsapp/groups/refresh', {}),
    onSuccess: () => {
      toast.ok('Memuat ulang daftar grup…');
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['wa-groups'] }), 2500);
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  const saveMode = useMutation({
    mutationFn: (mode: string) => api.patch(`/sites/${site.id}`, { whatsappMode: mode }),
    onSuccess: (_d, mode) => {
      toast.ok(`Mode WA ${site.name} → ${mode}`);
      qc.invalidateQueries({ queryKey: ['sites'] });
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post(`/sites/${site.id}/recipients`, body),
    onSuccess: () => {
      setForm({ name: '', kind: 'number', target: '', role: 'technician' });
      qc.invalidateQueries({ queryKey: ['wa-recipients', site.id] });
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const del = useMutation({
    mutationFn: (rid: string) => api.del(`/sites/${site.id}/recipients/${rid}`),
    onSuccess: () => {
      toast.ok('Penerima dihapus');
      qc.invalidateQueries({ queryKey: ['wa-recipients', site.id] });
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const toggle = (r: WaRecipient, patch: Partial<WaRecipient>) =>
    save.mutate({
      id: r.id,
      name: r.name,
      kind: r.kind,
      target: r.target,
      role: r.role,
      alerts: r.alerts,
      tickets: r.tickets,
      isActive: r.isActive,
      ...patch,
    });

  const columns: ReadonlyArray<Column<WaRecipient>> = [
    {
      key: 'kind',
      header: 'Jenis',
      cell: (r) => (
        <Badge tone={r.kind === 'group' ? 'violet' : 'sky'}>{r.kind === 'group' ? 'Grup' : 'Nomor'}</Badge>
      ),
      className: 'w-20',
    },
    {
      key: 'name',
      header: 'Nama',
      cell: (r) => <span className="font-medium text-slate-100">{r.name}</span>,
    },
    {
      key: 'target',
      header: 'Tujuan',
      cell: (r) => <span className="font-mono text-xs text-slate-400">{r.target}</span>,
    },
    {
      key: 'role',
      header: 'Peran',
      hideBelow: 'md',
      cell: (r) => <span className="text-slate-400">{r.role}</span>,
    },
    {
      key: 'subs',
      header: 'Langganan',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <FlagPill on={r.alerts} label="alert" onClick={() => toggle(r, { alerts: !r.alerts })} />
          <FlagPill on={r.tickets} label="tiket" onClick={() => toggle(r, { tickets: !r.tickets })} />
        </span>
      ),
    },
    {
      key: 'active',
      header: 'Aktif',
      cell: (r) => <FlagPill on={r.isActive} label={r.isActive ? 'aktif' : 'nonaktif'} onClick={() => toggle(r, { isActive: !r.isActive })} />,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      label: null,
      cell: (r) => (
        <button
          className="noc-tap rounded-md px-2 py-1 text-2xs font-medium text-red-400 hover:bg-red-500/10"
          onClick={() => del.mutate(r.id)}
        >
          Hapus
        </button>
      ),
      className: 'w-16',
    },
  ];

  return (
    <div className="space-y-3">
      {/* Site picker + alert mode — the two controls that scope everything below. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <Tabs
          value={siteId}
          onChange={onSiteChange}
          tabs={sites.map((s) => ({ value: s.id, label: s.name }))}
        />
        <div className="flex items-center gap-2">
          <span className="text-2xs font-medium uppercase tracking-wide text-slate-500">Mode alert</span>
          <Select
            value={site.whatsappMode}
            onChange={(e) => saveMode.mutate(e.target.value)}
            className="w-28"
            disabled={saveMode.isPending}
          >
            <option value="off">off</option>
            <option value="server">server</option>
          </Select>
          {site.whatsappMode === 'server' && <Badge tone="emerald">aktif</Badge>}
        </div>
      </div>

      <DataTable
        dense
        columns={columns}
        rows={recipients.data ?? []}
        rowKey={(r) => r.id}
        loading={recipients.isLoading}
        error={recipients.isError}
        onRetry={() => void recipients.refetch()}
        empty={`Belum ada penerima untuk ${site.name} — tambahkan nomor teknisi atau grup WA di bawah.`}
      />

      {/* Inline add — placeholders keep it one compact row on wide screens. */}
      <div className="grid grid-cols-2 items-end gap-2 rounded-xl border border-surface-border bg-surface/40 p-3 md:grid-cols-5">
        <Field label="Nama">
          <TextInput
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Teknisi A"
          />
        </Field>
        <Field label="Jenis">
          <Select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as WaRecipientKind, target: '' })}
          >
            <option value="number">Nomor</option>
            <option value="group">Grup</option>
          </Select>
        </Field>
        <Field label={form.kind === 'group' ? 'Grup WhatsApp' : 'Nomor WA'}>
          {form.kind === 'group' ? (
            groups.data && groups.data.length > 0 ? (
              <div className="flex gap-1.5">
                <Select
                  value={form.target}
                  onChange={(e) => {
                    const g = groups.data!.find((x) => x.jid === e.target.value);
                    // Nama otomatis dari subject grup — bisa dioverride.
                    setForm({ ...form, target: e.target.value, name: form.name || (g?.name ?? '') });
                  }}
                  className="flex-1"
                >
                  <option value="">— pilih grup —</option>
                  {groups.data.map((g) => (
                    <option key={g.jid} value={g.jid}>
                      {g.name}
                      {g.size ? ` (${g.size})` : ''}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  className="px-2"
                  title="Muat ulang daftar grup"
                  onClick={() => refreshGroups.mutate()}
                  disabled={refreshGroups.isPending}
                >
                  ⟳
                </Button>
              </div>
            ) : (
              <div>
                <TextInput
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                  placeholder="12036xxx@g.us"
                />
                <p className="mt-1 text-2xs text-amber-500">
                  {session.data?.status === 'connected'
                    ? 'Bot belum tergabung di grup manapun — undang bot ke grup dulu, lalu ⟳'
                    : 'Daftar grup muncul setelah bot terhubung — atau isi JID manual.'}
                  {session.data?.status === 'connected' && (
                    <button
                      type="button"
                      className="ml-1 underline"
                      onClick={() => refreshGroups.mutate()}
                    >
                      muat ulang
                    </button>
                  )}
                </p>
              </div>
            )
          ) : (
            <TextInput
              value={form.target}
              onChange={(e) => setForm({ ...form, target: e.target.value })}
              placeholder="0812xxx"
            />
          )}
        </Field>
        <Field label="Peran">
          <Select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as SiteContactRole })}
          >
            <option value="technician">teknisi</option>
            <option value="manager">manager</option>
            <option value="noc">noc</option>
          </Select>
        </Field>
        <Button
          variant="secondary"
          onClick={() =>
            save.mutate({ name: form.name, kind: form.kind, target: form.target, role: form.role })
          }
          disabled={!form.name || !form.target || save.isPending}
        >
          {save.isPending ? 'Menambah…' : '+ Tambah'}
        </Button>
      </div>
      <p className="text-2xs text-slate-500">
        <em>alert</em> = terima notif device down/up · <em>tiket</em> = terima forward komplain ·
        role <em>manager</em> = target eskalasi tiket.
      </p>
    </div>
  );
}

// ---- Log pengiriman ----------------------------------------------------------

interface WaMessageRow {
  id: string;
  to: string;
  kind: string;
  status: 'queued' | 'sent' | 'failed' | 'dead';
  attempts: number;
  body: string;
  siteName: string | null;
  createdAt: string;
}

const MSG_STATUS_TONE: Record<WaMessageRow['status'], Tone> = {
  queued: 'slate',
  sent: 'emerald',
  failed: 'amber',
  dead: 'red',
};
const MSG_STATUS_LABEL: Record<WaMessageRow['status'], string> = {
  queued: 'antre',
  sent: 'terkirim',
  failed: 'retry',
  dead: 'dead',
};

/**
 * Delivery log + dead-letter recovery — the web twin of the bot's
 * WADEAD/KIRIMULANG commands. "Alert tidak sampai" is diagnosable here without
 * SSH: status + attempts + the message body are all visible, and a dead row
 * can be requeued in one click.
 */
function MessageLogCard() {
  const toast = useToast();
  const [status, setStatus] = useState<'all' | WaMessageRow['status']>('all');
  const q = useQuery({
    queryKey: ['wa-messages', status],
    queryFn: () =>
      api.get<WaMessageRow[]>(
        `/whatsapp/messages?take=80${status === 'all' ? '' : `&status=${status}`}`,
      ),
    refetchInterval: liteInterval(15_000),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/whatsapp/messages/${id}/retry`, {}),
    onSuccess: () => {
      toast.ok('Pesan di-antrekan ulang');
      void q.refetch();
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  const columns: ReadonlyArray<Column<WaMessageRow>> = [
    {
      key: 'at',
      header: 'Waktu',
      cell: (r) => (
        <span className="whitespace-nowrap text-2xs text-slate-400">
          {new Date(r.createdAt).toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      ),
      className: 'w-24',
    },
    {
      key: 'to',
      header: 'Tujuan',
      cell: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-mono text-xs text-slate-200">{r.to}</span>
          {r.siteName && <span className="text-2xs text-slate-500">{r.siteName}</span>}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Jenis',
      hideBelow: 'md',
      cell: (r) => <span className="text-2xs text-slate-400">{r.kind}</span>,
      className: 'w-20',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <Badge tone={MSG_STATUS_TONE[r.status]}>
          {MSG_STATUS_LABEL[r.status]}
          {r.attempts > 1 ? ` ·${r.attempts}x` : ''}
        </Badge>
      ),
      className: 'w-24',
    },
    {
      key: 'body',
      header: 'Pesan',
      cell: (r) => (
        <span className="block max-w-md truncate text-2xs text-slate-400" title={r.body}>
          {r.body.replace(/\n/g, ' · ')}
        </span>
      ),
      hideBelow: 'lg',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      label: null,
      cell: (r) =>
        r.status === 'dead' ? (
          <button
            className="noc-tap rounded-md px-2 py-1 text-2xs font-medium text-accent hover:bg-accent/10"
            onClick={() => retry.mutate(r.id)}
            disabled={retry.isPending}
          >
            Antrekan ulang
          </button>
        ) : null,
      className: 'w-24',
    },
  ];

  return (
    <Card className="p-4">
      <SectionHeader
        title="Log Pengiriman"
        action={
          <Tabs
            value={status}
            onChange={setStatus}
            tabs={[
              { value: 'all', label: 'Semua' },
              { value: 'queued', label: 'Antre' },
              { value: 'sent', label: 'Terkirim' },
              { value: 'failed', label: 'Retry' },
              { value: 'dead', label: 'Dead' },
            ]}
          />
        }
      />
      <DataTable
        dense
        columns={columns}
        rows={q.data ?? []}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError}
        onRetry={() => void q.refetch()}
        empty="Belum ada pesan pada filter ini."
      />
      <p className="mt-2 text-2xs text-slate-500">
        80 pesan terbaru · <em>dead</em> = 5x gagal kirim (nomor salah / bukan anggota grup) —
        perbaiki tujuannya lalu &quot;Antrekan ulang&quot;.
      </p>
    </Card>
  );
}

// ---- Pengaturan bot ----------------------------------------------------------

function BotSettingsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [form, setForm] = useState<Settings | null>(null);

  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('not loaded');
      return api.patch<Settings>('/settings', {
        waDownTemplate: form.waDownTemplate,
        waUpTemplate: form.waUpTemplate,
        waBotName: form.waBotName,
        waComplaintEnabled: form.waComplaintEnabled,
        waTicketEscalateMin: Number(form.waTicketEscalateMin),
      });
    },
    onSuccess: (s) => {
      setForm(s);
      qc.setQueryData(['settings'], s);
      toast.ok('Pengaturan bot tersimpan');
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  return (
    <Card className="p-4">
      <SectionHeader title="Pengaturan Bot" />
      {q.isLoading || !form ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Field label="Template DOWN">
              <Textarea
                value={form.waDownTemplate}
                onChange={(e) => setForm({ ...form, waDownTemplate: e.target.value })}
                rows={3}
              />
            </Field>
            <Field label="Template UP / RECOVERY">
              <Textarea
                value={form.waUpTemplate}
                onChange={(e) => setForm({ ...form, waUpTemplate: e.target.value })}
                rows={3}
              />
            </Field>
          </div>
          <p className="text-2xs text-slate-500">
            Placeholder sama dengan Telegram: {ALERT_PLACEHOLDERS.join(' ')}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Nama bot">
              <TextInput
                value={form.waBotName}
                onChange={(e) => setForm({ ...form, waBotName: e.target.value })}
              />
            </Field>
            <Field label="Eskalasi tiket (menit)">
              <TextInput
                value={String(form.waTicketEscalateMin)}
                onChange={(e) => setForm({ ...form, waTicketEscalateMin: Number(e.target.value) })}
              />
            </Field>
            <div className="col-span-2 flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={form.waComplaintEnabled}
                  onChange={(e) => setForm({ ...form, waComplaintEnabled: e.target.checked })}
                />
                Terima komplain dari nomor yang tidak dikenal
              </label>
            </div>
          </div>
          <div>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Menyimpan…' : 'Simpan pengaturan bot'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---- Uji & broadcast ---------------------------------------------------------

function TestBroadcastCard() {
  const sites = useSites();
  const toast = useToast();
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState('Tes dari NOC ✅');
  const [bcSite, setBcSite] = useState('');
  const [bcText, setBcText] = useState('');

  const test = useMutation({
    mutationFn: () => api.post<{ id: string }>('/whatsapp/test', { to: testTo, text: testMsg }),
    onSuccess: () => toast.ok('Pesan uji masuk antrian'),
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });
  const broadcast = useMutation({
    mutationFn: () =>
      api.post<{ queued: number }>('/whatsapp/broadcast', { siteId: bcSite, text: bcText }),
    onSuccess: (r) => {
      toast.ok(`Broadcast masuk antrian ke ${r.queued} penerima`);
      setBcText('');
    },
    onError: (e) => toast.error(`Gagal: ${(e as Error).message}`),
  });

  return (
    <Card className="p-4">
      <SectionHeader title="Uji & Broadcast" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-medium text-slate-300">Kirim pesan uji</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Ke nomor">
              <TextInput
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="62812xxx"
                className="w-40"
              />
            </Field>
            <div className="min-w-[200px] flex-1">
              <Field label="Pesan">
                <TextInput value={testMsg} onChange={(e) => setTestMsg(e.target.value)} />
              </Field>
            </div>
            <Button onClick={() => test.mutate()} disabled={test.isPending || !testTo || !testMsg}>
              {test.isPending ? 'Mengirim…' : 'Kirim'}
            </Button>
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-slate-300">Broadcast pengumuman</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Site">
              <Select value={bcSite} onChange={(e) => setBcSite(e.target.value)} className="w-40">
                <option value="">— pilih site —</option>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="min-w-[200px] flex-1">
              <Field label="Pesan">
                <TextInput
                  value={bcText}
                  onChange={(e) => setBcText(e.target.value)}
                  placeholder="Info pemeliharaan / pengumuman…"
                />
              </Field>
            </div>
            <Button
              onClick={() => broadcast.mutate()}
              disabled={broadcast.isPending || !bcSite || !bcText}
            >
              {broadcast.isPending ? 'Mengirim…' : 'Broadcast'}
            </Button>
          </div>
          <p className="mt-2 text-2xs text-slate-500">
            Terkirim ke semua penerima site + member yang nomornya terverifikasi.
          </p>
        </div>
      </div>
    </Card>
  );
}
