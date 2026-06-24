'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { RuijieRouterPublic } from '@noc/shared';
import { useAuth } from '@/lib/auth';
import { useRuijieRouters } from '@/lib/queries';
import { Card, EmptyState, ErrorState, Loading, Page, PageBody, PageHeader } from '@/components/ui';

// Ruijie WiFi — monitoring overview. One card per monitored project (grouped by
// Ruijie Cloud groupName); click a card to drill into its access points and
// connected clients at /ruijie/<project>. Account management lives separately at
// /admin/ruijie so this view stays clean of credential forms.
export default function RuijiePage() {
  const { can } = useAuth();
  const routers = useRuijieRouters();

  const list = routers.data ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, RuijieRouterPublic[]>();
    for (const r of list) m.set(r.groupName, [...(m.get(r.groupName) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);
  const totalClients = list.reduce((n, r) => n + r.clientCount, 0);
  const online = list.filter((r) => r.online).length;

  return (
    <Page>
      <PageHeader
        title="Ruijie WiFi"
        subtitle={
          list.length
            ? `${groups.length} project · ${online}/${list.length} AP online · ${totalClients} client terkoneksi`
            : 'Status & jumlah client per project'
        }
      />
      <PageBody width="wide">
        {routers.isError ? (
          <ErrorState onRetry={() => void routers.refetch()}>Gagal memuat data Ruijie.</ErrorState>
        ) : routers.isLoading ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState>
            Belum ada project dipantau.{' '}
            {can('ruijie:manage') ? (
              <>
                Buka{' '}
                <Link href="/admin/ruijie" className="text-accent hover:underline">
                  Ruijie Cloud
                </Link>{' '}
                untuk menambah akun &amp; memilih project.
              </>
            ) : (
              'Minta admin menambahkan akun Ruijie Cloud.'
            )}
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map(([name, rs]) => (
              <ProjectCard key={name} name={name} routers={rs} />
            ))}
          </div>
        )}
      </PageBody>
    </Page>
  );
}

function ProjectCard({ name, routers }: { name: string; routers: RuijieRouterPublic[] }) {
  const clients = routers.reduce((n, r) => n + r.clientCount, 0);
  const online = routers.filter((r) => r.online).length;
  const allOnline = online === routers.length;
  return (
    <Link href={`/ruijie/${encodeURIComponent(name)}`} className="group block">
      <Card className="h-full p-4 transition hover:border-accent/60 hover:bg-surface/40">
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 flex-1 truncate font-semibold text-slate-100" title={name}>
            {name}
          </h2>
          <span className="shrink-0 text-slate-500 transition group-hover:translate-x-0.5">→</span>
        </div>
        <div className="mt-3 flex items-end justify-between gap-2">
          <div>
            <div className="text-3xl font-semibold leading-none text-slate-100">{clients}</div>
            <div className="mt-1 text-xs text-slate-500">client terkoneksi</div>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
              allOnline ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${allOnline ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {online}/{routers.length} AP
          </span>
        </div>
      </Card>
    </Link>
  );
}
