'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Company, RouterResource, Site } from '@noc/shared';
import { api } from '@/lib/api';
import { qk, useRouters, useSites } from '@/lib/queries';
import { Button, Card, Field, Select, Spinner, TextInput } from '@/components/ui';

export default function AdminSitesPage() {
  const qc = useQueryClient();
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api.get<Company[]>('/companies') });
  const sites = useSites();
  const routers = useRouters();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['companies'] });
    qc.invalidateQueries({ queryKey: qk.sites });
    qc.invalidateQueries({ queryKey: qk.routers() });
  };

  // ---- forms state ----
  const [companyName, setCompanyName] = useState('');
  const [siteForm, setSiteForm] = useState({ companyId: '', name: '', mapMode: 'geo', geoCenterLat: '-6.2', geoCenterLng: '106.8', defaultZoom: '13' });
  const [routerForm, setRouterForm] = useState({ siteId: '', name: '', host: '', apiPort: '8728', useTls: false, username: 'admin', password: '', routerosVersion: 'v6' });
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [importMsg, setImportMsg] = useState<Record<string, string>>({});
  const [scriptFor, setScriptFor] = useState<{ routerId: string; host: string; cli: string; mode: string } | null>(null);

  const addCompany = useMutation({ mutationFn: () => api.post('/companies', { name: companyName }), onSuccess: () => { setCompanyName(''); invalidate(); } });
  const addSite = useMutation({
    mutationFn: () =>
      api.post('/sites', {
        companyId: siteForm.companyId,
        name: siteForm.name,
        mapMode: siteForm.mapMode,
        geoCenterLat: siteForm.mapMode === 'geo' ? Number(siteForm.geoCenterLat) : undefined,
        geoCenterLng: siteForm.mapMode === 'geo' ? Number(siteForm.geoCenterLng) : undefined,
        defaultZoom: Number(siteForm.defaultZoom),
      }),
    onSuccess: () => { setSiteForm({ ...siteForm, name: '' }); invalidate(); },
  });
  const addRouter = useMutation({
    mutationFn: () =>
      api.post('/routers', {
        siteId: routerForm.siteId,
        name: routerForm.name,
        host: routerForm.host,
        apiPort: Number(routerForm.apiPort),
        useTls: routerForm.useTls,
        username: routerForm.username,
        password: routerForm.password,
        routerosVersion: routerForm.routerosVersion,
      }),
    onSuccess: () => { setRouterForm({ ...routerForm, name: '', host: '', password: '' }); invalidate(); },
  });
  const delSite = useMutation({ mutationFn: (id: string) => api.del(`/sites/${id}`), onSuccess: invalidate });
  const delRouter = useMutation({ mutationFn: (id: string) => api.del(`/routers/${id}`), onSuccess: invalidate });

  const testConn = async (id: string) => {
    setTestResult((p) => ({ ...p, [id]: 'testing…' }));
    try {
      const r = await api.post<{ ok: boolean; resource: RouterResource }>(`/routers/${id}/test`, {});
      setTestResult((p) => ({ ...p, [id]: `OK · ${r.resource.identity ?? ''} ${r.resource.boardName ?? ''} v${r.resource.version ?? '?'}` }));
      invalidate();
    } catch (e) {
      setTestResult((p) => ({ ...p, [id]: `FAIL · ${(e as Error).message}` }));
    }
  };

  const loadScript = async (routerId: string, host: string) => {
    const r = await api.get<{ cli: string; telegramMode: string }>(`/routers/${routerId}/netwatch/script?host=${encodeURIComponent(host)}`);
    setScriptFor({ routerId, host, cli: r.cli, mode: r.telegramMode });
  };

  const importNetwatch = async (routerId: string) => {
    setImportMsg((p) => ({ ...p, [routerId]: 'importing…' }));
    try {
      const res = await api.post<{ imported: number; skipped: number }>(`/routers/${routerId}/import-netwatch`, {});
      setImportMsg((p) => ({ ...p, [routerId]: `+${res.imported} device (skip ${res.skipped}) — taruh ke Area/Line di map` }));
      invalidate();
    } catch (e) {
      setImportMsg((p) => ({ ...p, [routerId]: `gagal: ${(e as Error).message}` }));
    }
  };

  const sitesByCompany = (cid: string) => sites.data?.filter((s) => s.companyId === cid) ?? [];
  const routersBySite = (sid: string) => routers.data?.filter((r) => r.siteId === sid) ?? [];

  return (
    <div className="h-full space-y-6 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold text-slate-100">Sites &amp; Routers</h1>

      {/* Companies */}
      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-slate-200">Companies</h2>
        <div className="mb-3 flex items-end gap-2">
          <Field label="New company">
            <TextInput value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </Field>
          <Button onClick={() => addCompany.mutate()} disabled={!companyName}>Add</Button>
        </div>
        {companies.isLoading ? <Spinner /> : (
          <ul className="text-sm text-slate-300">
            {companies.data?.map((c) => <li key={c.id} className="py-0.5">{c.name}</li>)}
          </ul>
        )}
      </Card>

      {/* Sites */}
      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-slate-200">Sites</h2>
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Company">
            <Select value={siteForm.companyId} onChange={(e) => setSiteForm({ ...siteForm, companyId: e.target.value })}>
              <option value="">—</option>
              {companies.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Name"><TextInput value={siteForm.name} onChange={(e) => setSiteForm({ ...siteForm, name: e.target.value })} /></Field>
          <Field label="Map mode">
            <Select value={siteForm.mapMode} onChange={(e) => setSiteForm({ ...siteForm, mapMode: e.target.value })}>
              <option value="geo">geo</option>
              <option value="floorplan">floorplan</option>
            </Select>
          </Field>
          <Field label="Center lat"><TextInput value={siteForm.geoCenterLat} onChange={(e) => setSiteForm({ ...siteForm, geoCenterLat: e.target.value })} /></Field>
          <Field label="Center lng"><TextInput value={siteForm.geoCenterLng} onChange={(e) => setSiteForm({ ...siteForm, geoCenterLng: e.target.value })} /></Field>
          <Field label="Zoom"><TextInput value={siteForm.defaultZoom} onChange={(e) => setSiteForm({ ...siteForm, defaultZoom: e.target.value })} /></Field>
        </div>
        <Button onClick={() => addSite.mutate()} disabled={!siteForm.companyId || !siteForm.name}>Add site</Button>

        <div className="mt-4 space-y-2">
          {sites.data?.map((s) => (
            <SiteRow key={s.id} site={s} onDelete={() => delSite.mutate(s.id)} onUploaded={invalidate} />
          ))}
        </div>
      </Card>

      {/* Routers */}
      <Card className="p-4">
        <h2 className="mb-3 font-semibold text-slate-200">Routers (MikroTik)</h2>
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <Field label="Site">
            <Select value={routerForm.siteId} onChange={(e) => setRouterForm({ ...routerForm, siteId: e.target.value })}>
              <option value="">—</option>
              {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Name"><TextInput value={routerForm.name} onChange={(e) => setRouterForm({ ...routerForm, name: e.target.value })} /></Field>
          <Field label="Host"><TextInput value={routerForm.host} onChange={(e) => setRouterForm({ ...routerForm, host: e.target.value })} /></Field>
          <Field label="Port"><TextInput value={routerForm.apiPort} onChange={(e) => setRouterForm({ ...routerForm, apiPort: e.target.value })} /></Field>
          <Field label="User"><TextInput value={routerForm.username} onChange={(e) => setRouterForm({ ...routerForm, username: e.target.value })} /></Field>
          <Field label="Password"><TextInput type="password" value={routerForm.password} onChange={(e) => setRouterForm({ ...routerForm, password: e.target.value })} /></Field>
          <Field label="Version">
            <Select value={routerForm.routerosVersion} onChange={(e) => setRouterForm({ ...routerForm, routerosVersion: e.target.value })}>
              <option value="v6">v6</option>
              <option value="v7">v7</option>
            </Select>
          </Field>
        </div>
        <Button onClick={() => addRouter.mutate()} disabled={!routerForm.siteId || !routerForm.host}>Add router</Button>

        <div className="mt-4 space-y-2">
          {routers.data?.map((r) => (
            <div key={r.id} className="rounded border border-surface-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-slate-100">{r.name}</span>{' '}
                  <span className="text-slate-500">{r.host}:{r.apiPort} · {r.routerosVersion} · {r.status}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => testConn(r.id)}>Test</Button>
                  <Button variant="secondary" onClick={() => importNetwatch(r.id)}>Import</Button>
                  <Button variant="ghost" onClick={() => { const host = prompt('Device IP/host for the Netwatch script:'); if (host) void loadScript(r.id, host); }}>Netwatch script</Button>
                  <button className="text-red-400 hover:text-red-300" onClick={() => delRouter.mutate(r.id)}>delete</button>
                </div>
              </div>
              {testResult[r.id] && <div className="mt-1 text-xs text-slate-400">{testResult[r.id]}</div>}
              {importMsg[r.id] && <div className="mt-1 text-xs text-emerald-400">{importMsg[r.id]}</div>}
            </div>
          ))}
        </div>
      </Card>

      {scriptFor && (
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold text-slate-200">Netwatch script · {scriptFor.host}</h2>
            <button className="text-slate-400" onClick={() => setScriptFor(null)}>✕</button>
          </div>
          <p className="mb-2 text-xs text-slate-400">
            Paste ke terminal router, atau install via API. Webhook update status realtime.
            {scriptFor.mode === 'router' && ' Script ini sudah termasuk alert Telegram untuk device critical.'}
          </p>
          <pre className="overflow-x-auto rounded bg-surface p-3 text-xs text-slate-200">{scriptFor.cli}</pre>
        </Card>
      )}
    </div>
  );
}

function SiteRow({ site, onDelete, onUploaded }: { site: Site; onDelete: () => void; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [dims, setDims] = useState({ w: '1600', h: '1000' });
  const [busy, setBusy] = useState(false);
  const [tg, setTg] = useState({ mode: site.telegramMode as string, chatId: site.telegramChatId ?? '', token: '' });
  const [tgMsg, setTgMsg] = useState('');
  const saveTg = useMutation({
    mutationFn: () =>
      api.patch(`/sites/${site.id}`, {
        telegramMode: tg.mode,
        telegramChatId: tg.chatId || null,
        ...(tg.token ? { telegramBotToken: tg.token } : {}),
      }),
    onSuccess: () => {
      setTg((t) => ({ ...t, token: '' }));
      setTgMsg('Tersimpan ✓');
      onUploaded();
    },
    onError: (e) => setTgMsg((e as Error).message),
  });
  const testTg = useMutation({
    mutationFn: () => api.post(`/sites/${site.id}/telegram/test`, {}),
    onSuccess: () => setTgMsg('Pesan tes terkirim ✓'),
    onError: (e) => setTgMsg(`Gagal: ${(e as Error).message}`),
  });

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.upload(`/sites/${site.id}/floorplan?width=${dims.w}&height=${dims.h}`, form);
      onUploaded();
    } finally {
      setBusy(false);
      setFile(null);
    }
  };

  return (
    <div className="rounded border border-surface-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium text-slate-100">{site.name}</span>{' '}
          <span className="text-slate-500">· {site.mapMode}</span>
        </div>
        <button className="text-red-400 hover:text-red-300" onClick={onDelete}>delete</button>
      </div>
      {site.mapMode === 'floorplan' && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs text-slate-400" />
          <Field label="W"><TextInput value={dims.w} onChange={(e) => setDims({ ...dims, w: e.target.value })} className="w-20" /></Field>
          <Field label="H"><TextInput value={dims.h} onChange={(e) => setDims({ ...dims, h: e.target.value })} className="w-20" /></Field>
          <Button variant="secondary" onClick={upload} disabled={!file || busy}>{busy ? 'Uploading…' : 'Upload floorplan'}</Button>
        </div>
      )}

      <div className="mt-3 border-t border-surface-border pt-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Telegram alert (device critical)
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Mode">
            <Select value={tg.mode} onChange={(e) => setTg({ ...tg, mode: e.target.value })} className="w-28">
              <option value="off">off</option>
              <option value="server">server</option>
              <option value="router">router</option>
            </Select>
          </Field>
          <Field label="Chat ID">
            <TextInput value={tg.chatId} onChange={(e) => setTg({ ...tg, chatId: e.target.value })} placeholder="-100123456" className="w-36" />
          </Field>
          <Field label={site.hasTelegramToken ? 'Bot token (tersimpan)' : 'Bot token'}>
            <TextInput
              type="password"
              value={tg.token}
              onChange={(e) => setTg({ ...tg, token: e.target.value })}
              placeholder={site.hasTelegramToken ? 'kosong = tetap' : '123456:ABC-DEF…'}
              className="w-44"
            />
          </Field>
          <Button onClick={() => saveTg.mutate()} disabled={saveTg.isPending}>Simpan</Button>
          <Button variant="secondary" onClick={() => testTg.mutate()} disabled={testTg.isPending}>Kirim tes</Button>
        </div>
        {tgMsg && <div className="mt-1 text-xs text-slate-400">{tgMsg}</div>}
        <p className="mt-1 text-[11px] text-slate-500">
          server = NOC yang kirim (token aman di server) · router = script Netwatch yang kirim (perlu Install/Sync di router) · hanya device is_critical.
        </p>
      </div>
    </div>
  );
}
