'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ALERT_PLACEHOLDERS, type Settings } from '@noc/shared';
import { api } from '@/lib/api';
import { Button, Card, Field, Select, Spinner, Textarea, TextInput } from '@/components/ui';

// Sensible accent presets so admins do not need to think in RGB triplets.
const ACCENT_PRESETS: Array<{ name: string; rgb: string; hex: string }> = [
  { name: 'Blue',   rgb: '59 130 246',  hex: '#3B82F6' },
  { name: 'Indigo', rgb: '99 102 241',  hex: '#6366F1' },
  { name: 'Violet', rgb: '139 92 246',  hex: '#8B5CF6' },
  { name: 'Pink',   rgb: '236 72 153',  hex: '#EC4899' },
  { name: 'Red',    rgb: '239 68 68',   hex: '#EF4444' },
  { name: 'Amber',  rgb: '245 158 11',  hex: '#F59E0B' },
  { name: 'Emerald',rgb: '16 185 129',  hex: '#10B981' },
  { name: 'Teal',   rgb: '20 184 166',  hex: '#14B8A6' },
  { name: 'Cyan',   rgb: '6 182 212',   hex: '#06B6D4' },
  { name: 'Slate',  rgb: '100 116 139', hex: '#64748B' },
];

export default function AdminSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [form, setForm] = useState<Settings | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('not loaded');
      return api.patch<Settings>('/settings', {
        orgName: form.orgName,
        logoUrl: form.logoUrl,
        accentRgb: form.accentRgb,
        themeDefault: form.themeDefault,
        defaultMapLat: Number(form.defaultMapLat),
        defaultMapLng: Number(form.defaultMapLng),
        defaultMapZoom: Number(form.defaultMapZoom),
        defaultPollSec: Number(form.defaultPollSec),
        eventRetentionDays: Number(form.eventRetentionDays),
        auditRetentionDays: Number(form.auditRetentionDays),
        netwatchIntervalSec: Number(form.netwatchIntervalSec),
        netwatchTimeoutMs: Number(form.netwatchTimeoutMs),
        netwatchExtraUp: form.netwatchExtraUp,
        netwatchExtraDown: form.netwatchExtraDown,
        telegramDownTemplate: form.telegramDownTemplate,
        telegramUpTemplate: form.telegramUpTemplate,
      });
    },
    onSuccess: (s) => {
      setForm(s);
      qc.setQueryData(['settings'], s);
      qc.invalidateQueries({ queryKey: ['branding'] });
      setSavedMsg('Tersimpan ✓');
      window.setTimeout(() => setSavedMsg(''), 3000);
    },
    onError: (e) => setSavedMsg(`Gagal: ${(e as Error).message}`),
  });

  const uploadLogo = async (file: File) => {
    setLogoBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.upload<{ logoUrl: string }>('/settings/logo', fd);
      setForm((p) => (p ? { ...p, logoUrl: r.logoUrl } : p));
      qc.invalidateQueries({ queryKey: ['branding'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    } finally {
      setLogoBusy(false);
    }
  };

  if (q.isLoading || !form) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  if (q.isError) {
    return <div className="p-6 text-red-400">Tidak bisa memuat Settings: {(q.error as Error).message}</div>;
  }

  return (
    <div className="h-full space-y-6 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Settings</h1>
        <span className="text-xs text-slate-500">Pembaruan: {new Date(form.updatedAt).toLocaleString()}</span>
      </div>

      {/* ---- Branding ---- */}
      <Card className="space-y-4 p-4">
        <h2 className="font-semibold text-slate-200">Branding (white-label)</h2>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Nama organisasi">
            <TextInput value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} />
          </Field>
          <Field label="Tema default">
            <Select
              value={form.themeDefault}
              onChange={(e) => setForm({ ...form, themeDefault: e.target.value as 'dark' | 'light' })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </Select>
          </Field>
          <Field label="Accent (R G B)">
            <TextInput
              value={form.accentRgb}
              onChange={(e) => setForm({ ...form, accentRgb: e.target.value })}
              placeholder="59 130 246"
            />
          </Field>
        </div>

        <div>
          <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Accent preset
          </span>
          <div className="flex flex-wrap gap-2">
            {ACCENT_PRESETS.map((p) => {
              const active = p.rgb === form.accentRgb;
              return (
                <button
                  key={p.name}
                  type="button"
                  title={p.name}
                  onClick={() => setForm({ ...form, accentRgb: p.rgb })}
                  className={`flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                    active ? 'border-slate-300 text-slate-100' : 'border-surface-border text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="h-4 w-4 rounded" style={{ background: p.hex }} />
                  {p.name}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-3 text-xs text-slate-400">
            <span>Preview:</span>
            <span className="rounded bg-accent px-3 py-1 text-white">Active item</span>
            <span className="text-accent">accent text</span>
            <span className="rounded border border-accent px-2 py-0.5">accent border</span>
          </div>
        </div>

        <div>
          <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">Logo</span>
          <div className="flex items-center gap-3">
            {form.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.logoUrl} alt="logo" className="h-12 w-12 rounded object-contain ring-1 ring-surface-border" />
            ) : (
              <span aria-hidden className="h-12 w-12 rounded bg-accent" />
            )}
            <label className="cursor-pointer text-xs text-accent hover:opacity-80">
              {logoBusy ? 'Mengunggah…' : 'Unggah logo (PNG/SVG)…'}
              <input
                type="file"
                accept="image/png,image/webp,image/jpeg,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadLogo(f);
                }}
              />
            </label>
            {form.logoUrl && (
              <button
                type="button"
                className="text-xs text-red-400 hover:text-red-300"
                onClick={() => setForm({ ...form, logoUrl: null })}
              >
                hapus
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Logo + nama tampil di sidebar dan halaman login. Jangan lupa Simpan.
          </p>
        </div>
      </Card>

      {/* ---- Defaults ---- */}
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-slate-200">Default peta &amp; polling</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Center lat">
            <TextInput value={String(form.defaultMapLat)} onChange={(e) => setForm({ ...form, defaultMapLat: Number(e.target.value) })} />
          </Field>
          <Field label="Center lng">
            <TextInput value={String(form.defaultMapLng)} onChange={(e) => setForm({ ...form, defaultMapLng: Number(e.target.value) })} />
          </Field>
          <Field label="Default zoom">
            <TextInput value={String(form.defaultMapZoom)} onChange={(e) => setForm({ ...form, defaultMapZoom: Number(e.target.value) })} />
          </Field>
          <Field label="Poll interval (detik)">
            <TextInput value={String(form.defaultPollSec)} onChange={(e) => setForm({ ...form, defaultPollSec: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>

      {/* ---- Monitoring & Alerts (Netwatch + Telegram templates) ---- */}
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="font-semibold text-slate-200">Monitoring &amp; Alerts</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Default ping/timeout dan template alert untuk Netwatch + Telegram.
            Operator hanya memasukkan IP — konfigurasi ada di sini.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Ping interval (detik)">
            <TextInput
              value={String(form.netwatchIntervalSec)}
              onChange={(e) => setForm({ ...form, netwatchIntervalSec: Number(e.target.value) })}
            />
          </Field>
          <Field label="ICMP timeout (ms)">
            <TextInput
              value={String(form.netwatchTimeoutMs)}
              onChange={(e) => setForm({ ...form, netwatchTimeoutMs: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Extra RouterOS script (opsional)
          </span>
          <p className="mb-2 text-[11px] text-slate-500">
            Dijalankan di MikroTik <em>setelah</em> webhook NOC. Contoh: nyalakan LED, log custom, fetch ke alat lain. Kosongkan untuk tidak ada tambahan.
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Field label="On DOWN">
              <Textarea
                value={form.netwatchExtraDown ?? ''}
                onChange={(e) => setForm({ ...form, netwatchExtraDown: e.target.value || null })}
                rows={4}
                className="font-mono text-xs"
                placeholder=':log warning "device down"'
              />
            </Field>
            <Field label="On UP">
              <Textarea
                value={form.netwatchExtraUp ?? ''}
                onChange={(e) => setForm({ ...form, netwatchExtraUp: e.target.value || null })}
                rows={4}
                className="font-mono text-xs"
                placeholder=':log info "device recovered"'
              />
            </Field>
          </div>
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Telegram message templates
          </span>
          <p className="mb-2 text-[11px] text-slate-500">
            Placeholder yang tersedia:{' '}
            {ALERT_PLACEHOLDERS.map((p) => (
              <code key={p} className="mx-0.5 rounded bg-surface px-1 text-slate-300">
                {p}
              </code>
            ))}
            . Berlaku untuk Telegram server-mode dan router-mode (Netwatch script).
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Field label="DOWN alert">
              <Textarea
                value={form.telegramDownTemplate}
                onChange={(e) => setForm({ ...form, telegramDownTemplate: e.target.value })}
                rows={3}
              />
            </Field>
            <Field label="UP / RECOVERY alert">
              <Textarea
                value={form.telegramUpTemplate}
                onChange={(e) => setForm({ ...form, telegramUpTemplate: e.target.value })}
                rows={3}
              />
            </Field>
          </div>
        </div>
      </Card>

      {/* ---- Retention ---- */}
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-slate-200">Retensi data</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Event status (hari)">
            <TextInput value={String(form.eventRetentionDays)} onChange={(e) => setForm({ ...form, eventRetentionDays: Number(e.target.value) })} />
          </Field>
          <Field label="Audit log (hari)">
            <TextInput value={String(form.auditRetentionDays)} onChange={(e) => setForm({ ...form, auditRetentionDays: Number(e.target.value) })} />
          </Field>
        </div>
        <p className="text-[11px] text-slate-500">
          Worker harian akan membersihkan data lebih lama dari batas ini.
        </p>
      </Card>

      <div className="sticky bottom-0 -mx-6 flex items-center gap-3 border-t border-surface-border bg-surface-raised/95 px-6 py-3 backdrop-blur">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Menyimpan…' : 'Simpan perubahan'}
        </Button>
        {q.data && (
          <Button variant="ghost" onClick={() => setForm(q.data)}>
            Reset
          </Button>
        )}
        {savedMsg && <span className="text-sm text-emerald-400">{savedMsg}</span>}
      </div>
    </div>
  );
}
