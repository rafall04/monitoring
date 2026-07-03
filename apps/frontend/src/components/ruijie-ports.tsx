import type { RuijiePortDTO } from '@noc/shared';

// Shared Ruijie LAN-port visuals — used by the per-project drill-down, the row
// uplink chip, and the dedicated Switch board. Keep presentation here; data
// fetching stays in the pages.

/** True when a Ruijie device model is a managed switch (vs an AP/router). */
export function isRuijieSwitch(model: string | null): boolean {
  const m = (model ?? '').toUpperCase();
  return /^(ES|NBS|XS|GS|RG-S|RG-NBS|SWITCH)/.test(m) || m.includes('ES208');
}

export function toMbit(speed: string | null): number {
  const m = /^([\d.]+)\s*(M|G)$/i.exec((speed ?? '').trim());
  if (!m) return 0;
  return Number(m[1]) * (m[2]!.toUpperCase() === 'G' ? 1000 : 1);
}

/** "1000M" → "1G", "100M" → "100M" — compact form for chips. */
export function speedShort(speed: string | null): string {
  const mbit = toMbit(speed);
  if (mbit >= 1000) return `${Math.round((mbit / 1000) * 10) / 10}G`;
  if (mbit > 0) return `${mbit}M`;
  return speed ?? '';
}

/** Tone for the negotiated speed: gigabit+ good, 100M attention, 10M bad. */
export function speedTone(speed: string | null): string {
  const mbit = toMbit(speed);
  if (mbit >= 1000) return 'text-emerald-600 dark:text-emerald-400';
  if (mbit >= 100) return 'text-amber-600 dark:text-amber-400';
  if (mbit > 0) return 'text-rose-600 dark:text-rose-400';
  return 'text-slate-400';
}

/** A tiny RJ45 jack pictogram (outline follows the port's link state color). */
export function JackIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 5h14v10h-3.5v4h-7v-4H5z" />
      <path d="M9 5v3M12 5v3M15 5v3" strokeWidth="1.3" />
    </svg>
  );
}

/** One port on a faceplate: green when up (with speed), gray down, dim if disabled. */
export function PortTile({ p, flagged }: { p: RuijiePortDTO; flagged?: boolean }) {
  const label = p.up ? (p.speed ?? 'Up') : p.enabled ? '—' : 'off';
  const title = `${p.name} · ${p.up ? `Up${p.speed ? ` ${p.speed}` : ''}` : p.enabled ? 'Down' : 'Dinonaktifkan'}${p.medium ? ` · ${p.medium}` : ''}${flagged ? ' · di bawah normal' : ''}`;
  return (
    <div
      title={title}
      className={`flex w-[4.25rem] shrink-0 flex-col items-center gap-0.5 rounded-lg border px-1 py-2 transition ${
        flagged
          ? 'border-rose-500/60 bg-rose-500/10'
          : p.up
            ? 'border-emerald-500/50 bg-emerald-500/10'
            : 'border-surface-border bg-surface/40'
      } ${p.enabled ? '' : 'opacity-50'}`}
    >
      <JackIcon
        className={
          flagged
            ? 'text-rose-600 dark:text-rose-400'
            : p.up
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-slate-400 dark:text-slate-600'
        }
      />
      <span
        className={`max-w-full truncate text-[10px] font-medium ${p.up ? 'text-slate-700 dark:text-slate-200' : 'text-slate-500'}`}
      >
        {p.name}
      </span>
      <span
        className={`text-[10px] font-semibold leading-none ${
          flagged ? 'text-rose-600 dark:text-rose-400' : p.up ? speedTone(p.speed) : 'text-slate-500'
        }`}
      >
        {label}
      </span>
      {p.medium && p.medium.toLowerCase() !== 'copper' && (
        <span className="text-[9px] uppercase text-sky-600 dark:text-sky-400">{p.medium}</span>
      )}
    </div>
  );
}

/**
 * Compact wired-uplink summary for a device row (no drill-down needed): fastest
 * up-port speed, plus up/total for multi-port switches. All ports down renders
 * neutrally — a WAN-uplinked AP legitimately idles its LAN ports.
 */
export function UplinkChip({ ports, loading }: { ports: RuijiePortDTO[] | undefined; loading: boolean }) {
  if (loading) {
    return <span className="h-5 w-14 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-500/20" />;
  }
  if (!ports || ports.length === 0) return null;
  const ups = ports.filter((p) => p.up);
  const top = ups.reduce<RuijiePortDTO | null>(
    (best, p) => (toMbit(p.speed) > toMbit(best?.speed ?? null) ? p : best),
    null,
  );
  const title = ports
    .map((p) => `${p.name} ${p.up ? `↑${p.speed ?? 'Up'}` : p.enabled ? 'down' : 'off'}`)
    .join(' · ');
  if (ups.length === 0) {
    return (
      <span
        title={title}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-500"
      >
        <JackIcon className="h-3 w-3 text-slate-400 dark:text-slate-600" /> LAN —
      </span>
    );
  }
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold"
    >
      <JackIcon className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      <span className={speedTone(top?.speed ?? null)}>↑{speedShort(top?.speed ?? null) || 'Up'}</span>
      {ports.length > 3 && <span className="font-medium text-slate-500">{ups.length}/{ports.length}</span>}
    </span>
  );
}
