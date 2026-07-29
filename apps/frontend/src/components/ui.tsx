'use client';

import { Fragment } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { STATUS_COLORS, STATUS_LABELS, type DisplayStatus } from '@noc/shared';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  // accent = brand color (CSS var --accent driven by Settings). Defaults to
  // blue-500 when no admin has customized it. Primary uses a subtle accent
  // gradient + glow for a livelier feel.
  primary: 'noc-accent-grad text-white shadow-sm shadow-accent/30 hover:brightness-110 active:scale-[.98]',
  secondary:
    'bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700/70 dark:text-slate-100 dark:hover:bg-slate-600 active:scale-[.98]',
  danger: 'bg-red-600 hover:bg-red-500 text-white shadow-sm shadow-red-900/40 active:scale-[.98]',
  ghost:
    'bg-transparent text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-surface-border bg-surface-raised shadow-sm shadow-black/20 ${className}`}
    >
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputBase =
  'noc-focus w-full rounded-lg border border-surface-border bg-surface/70 px-3 py-1.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-accent" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function StatusPill({ status }: { status: DisplayStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ color: c, background: `${c}1f`, border: `1px solid ${c}3d` }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ background: c, boxShadow: `0 0 6px ${c}` }}
      />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Legend() {
  const items: DisplayStatus[] = ['up', 'down', 'unknown', 'maintenance'];
  return (
    <div className="flex flex-wrap gap-3 text-xs text-slate-400">
      {items.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLORS[s] }} />
          {STATUS_LABELS[s]}
        </span>
      ))}
    </div>
  );
}

// ===========================================================================
// Page layout primitives — every (app) page is assembled from these so the
// header, scroll behaviour, content width and padding are IDENTICAL app-wide.
// Shell's <main> is overflow-hidden with no padding, so each page owns its own
// scroll + spacing; routing all of it through here is what keeps pages in sync.
// ===========================================================================

const PAGE_WIDTHS = {
  narrow: 'max-w-3xl',
  default: 'max-w-[1440px]',
  wide: 'max-w-[1800px]',
  full: 'max-w-none',
} as const;
export type PageWidth = keyof typeof PAGE_WIDTHS;

/**
 * The one horizontal gutter every page uses, ramped mobile → NOC display. Header
 * and body share it so the title always sits exactly above the content column.
 */
const PAGE_PAD = 'px-3 sm:px-4 md:px-5 lg:px-6 xl:px-8';

/** Full-height column: a fixed header on top, a single scrolling body below. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col">{children}</div>;
}

/**
 * Sticky page header bar (stays put while the body scrolls).
 *
 * Deliberately kept to title + subtitle + ONE primary action. Stats, tabs,
 * filters and secondary buttons belong in a <Toolbar> at the top of the body —
 * cramming them here is what used to wrap the header onto 2–3 rows and steal
 * height from the map/floorplan below.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  width = 'default',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  width?: PageWidth;
}) {
  return (
    <header className="shrink-0 border-b border-surface-border bg-surface-raised">
      <div
        className={`mx-auto flex w-full ${PAGE_WIDTHS[width]} ${PAGE_PAD} flex-col gap-x-4 gap-y-2 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:py-3`}
      >
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-slate-100">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Scrolling body with a centred, width-capped, padded content column. */
export function PageBody({
  children,
  width = 'default',
  className = '',
}: {
  children: ReactNode;
  width?: PageWidth;
  className?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={`mx-auto w-full ${PAGE_WIDTHS[width]} ${PAGE_PAD} space-y-5 py-4 sm:py-5 ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/** Segmented control used for in-page tabs (the single app-wide tab idiom). */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className = '',
}: {
  tabs: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex gap-1 rounded-xl border border-surface-border bg-surface/60 p-1 text-xs font-medium ${className}`}
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={`rounded-lg px-3 py-1.5 transition ${
            value === t.value
              ? 'noc-accent-grad text-white shadow-sm shadow-accent/30'
              : 'text-slate-500 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Centred spinner for in-body loading states (uniform across pages). */
export function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Spinner />
    </div>
  );
}

/** Muted, centred placeholder card for empty lists / tables. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <Card className="p-6 text-center text-sm text-slate-400">{children}</Card>;
}

/**
 * Failure placeholder for a query READ — visually distinct from EmptyState so a
 * fetch error never masquerades as "no data" (critical in a monitoring UI: an
 * empty list must mean "nothing", never "the request failed"). Pass `onRetry`
 * (usually a query's `refetch`) to offer a retry. Plain block, not a Card, so it
 * nests cleanly inside an existing Card as well as standing alone.
 */
export function ErrorState({
  children,
  onRetry,
}: {
  children?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-red-400">
      <span>{children ?? 'Gagal memuat data.'}</span>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Coba lagi
        </Button>
      )}
    </div>
  );
}

// ===========================================================================
// v2 building blocks — colorful, reusable pieces for the redesigned pages.
// ===========================================================================

// fg is mode-aware: darker (-600/-700) on light surfaces for contrast, brighter
// (-400) on the dark canvas. bg tint is a touch stronger in light mode so the
// pill reads on white. Keeps red/green from washing out to pastel in light mode.
const TONES = {
  accent: { fg: 'text-accent', bg: 'bg-accent/15 dark:bg-accent/12', ring: 'ring-accent/25' },
  emerald: { fg: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-500/15 dark:bg-emerald-500/12', ring: 'ring-emerald-500/25' },
  amber: { fg: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-500/15 dark:bg-amber-500/12', ring: 'ring-amber-500/25' },
  red: { fg: 'text-red-700 dark:text-red-400', bg: 'bg-red-500/15 dark:bg-red-500/12', ring: 'ring-red-500/25' },
  violet: { fg: 'text-violet-700 dark:text-violet-400', bg: 'bg-violet-500/15 dark:bg-violet-500/12', ring: 'ring-violet-500/25' },
  sky: { fg: 'text-sky-700 dark:text-sky-400', bg: 'bg-sky-500/15 dark:bg-sky-500/12', ring: 'ring-sky-500/25' },
  slate: { fg: 'text-slate-600 dark:text-slate-300', bg: 'bg-slate-500/15 dark:bg-slate-500/12', ring: 'ring-slate-500/25' },
} as const;
export type Tone = keyof typeof TONES;

/** Small square icon tile, tinted by tone — anchors cards, nav, list rows. */
export function IconTile({
  children,
  tone = 'accent',
  className = '',
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ${t.bg} ${t.fg} ${t.ring} ${className}`}
    >
      {children}
    </span>
  );
}

/** Summary metric tile: tinted icon + big number + label. Use in 2–4 col grids. */
export function MetricCard({
  label,
  value,
  hint,
  icon,
  tone = 'accent',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-surface-border bg-surface-raised p-3.5 shadow-sm shadow-black/20">
      {icon && <IconTile tone={tone}>{icon}</IconTile>}
      <div className="min-w-0">
        <div className="truncate text-xs text-slate-400">{label}</div>
        <div className="text-xl font-semibold leading-tight text-slate-100">{value}</div>
        {hint && <div className="truncate text-[11px] text-slate-500">{hint}</div>}
      </div>
    </div>
  );
}

/** Labelled section divider: tiny icon + uppercase title + colored rule + action. */
export function SectionHeader({
  title,
  icon,
  tone = 'accent',
  action,
}: {
  title: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      {icon && <span className={`${TONES[tone].fg}`}>{icon}</span>}
      <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">{title}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-surface-border to-transparent" />
      {action}
    </div>
  );
}

/** Compact colored tag. */
export function Badge({
  children,
  tone = 'slate',
  className = '',
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${t.bg} ${t.fg} ${className}`}
    >
      {children}
    </span>
  );
}

// ===========================================================================
// v3 — the shared control + table idioms. Before these existed each page rolled
// its own filter row and table (9 tables → 7 different <th> paddings, 4 <td>
// paddings, 4 with no mobile treatment), which is what made the app read as
// untidy. Everything below is mobile-first and ramps to the 3xl NOC breakpoint.
// ===========================================================================

/**
 * Secondary control row for the top of a PageBody: stats/tabs on the left,
 * actions on the right. This is where everything that used to be crammed into
 * PageHeader's `actions` belongs. Stacks vertically on phones.
 */
export function Toolbar({
  left,
  right,
  className = '',
}: {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 ${className}`}
    >
      {left && <div className="flex min-w-0 flex-wrap items-center gap-2">{left}</div>}
      {right && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{right}</div>}
    </div>
  );
}

/**
 * Search + filter controls + result count, in one layout. `children` takes the
 * page's own <Select>s; the count is pushed to the far end on ≥sm.
 */
export function FilterBar({
  search,
  onSearch,
  placeholder = 'Cari…',
  children,
  count,
  countLabel = 'baris',
  className = '',
}: {
  search?: string;
  onSearch?: (v: string) => void;
  placeholder?: string;
  children?: ReactNode;
  count?: number;
  countLabel?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center ${className}`}>
      {onSearch && (
        <TextInput
          value={search ?? ''}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={placeholder}
          className="w-full sm:w-56 xl:w-72"
        />
      )}
      {children}
      {count !== undefined && (
        <span className="text-xs text-slate-500 sm:ml-auto">
          {count} {countLabel}
        </span>
      )}
    </div>
  );
}

/** Status counts + availability, identical on Overview cards and site headers. */
export function StatusCounts({
  up,
  down,
  unknown = 0,
  maintenance = 0,
  availabilityPct,
}: {
  up: number;
  down: number;
  unknown?: number;
  maintenance?: number;
  availabilityPct?: number;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone="emerald">{up} up</Badge>
      {down > 0 && <Badge tone="red">{down} down</Badge>}
      {unknown > 0 && <Badge tone="slate">{unknown} ?</Badge>}
      {maintenance > 0 && <Badge tone="sky">{maintenance} mnt</Badge>}
      {availabilityPct !== undefined && (
        <span className="rounded-full border border-surface-border bg-surface px-2 py-0.5 text-2xs font-semibold text-slate-100">
          {availabilityPct}%
        </span>
      )}
    </span>
  );
}

// --- DataTable --------------------------------------------------------------

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /**
   * Stacked-card label on phones; falls back to `header` when it is a string.
   * Pass `null` for cells that should stay full-width when stacked (action
   * buttons, inline edit forms).
   */
  label?: string | null;
  /**
   * Drop this column below the given breakpoint so narrow screens are not
   * forced into horizontal scroll. Below 640px the table stacks into cards
   * instead, where every column is shown regardless.
   */
  hideBelow?: 'md' | 'lg' | 'xl';
  className?: string;
};

// Static strings — Tailwind's JIT cannot see interpolated class names.
const HIDE_BELOW: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

/**
 * The single table idiom: uniform header/cell padding, hover rows, built-in
 * loading / error / empty states, automatic mobile stacking via `r-table`, and
 * an optional expanded detail row.
 *
 * Renders its own <Card>, so callers must not wrap it in another one.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  dense = false,
  loading = false,
  error = false,
  onRetry,
  empty = 'Tidak ada data.',
  expandedKey,
  renderExpanded,
  className = '',
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T) => string;
  dense?: boolean;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  empty?: ReactNode;
  expandedKey?: string | null;
  renderExpanded?: (row: T) => ReactNode;
  className?: string;
}) {
  if (error)
    return (
      <Card className={className}>
        <ErrorState onRetry={onRetry} />
      </Card>
    );
  if (loading)
    return (
      <Card className={className}>
        <Loading />
      </Card>
    );
  if (rows.length === 0)
    return <Card className={`p-6 text-center text-sm text-slate-400 ${className}`}>{empty}</Card>;

  const pad = dense ? 'px-2.5 py-1.5' : 'px-3 py-2';

  return (
    <Card className={`overflow-x-auto ${className}`}>
      <table className="r-table w-full text-sm">
        <thead>
          <tr className="border-b border-surface-border text-left text-2xs font-semibold uppercase tracking-wide text-slate-500">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${pad} font-semibold ${c.align === 'right' ? 'text-right' : ''} ${
                  c.hideBelow ? HIDE_BELOW[c.hideBelow] : ''
                }`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const expanded = expandedKey === key && renderExpanded;
            return (
              <Fragment key={key}>
                <tr className="border-t border-surface-border transition-colors hover:bg-surface/50">
                  {columns.map((c) => {
                    const label = c.label === null ? undefined : c.label ?? (typeof c.header === 'string' ? c.header : undefined);
                    return (
                      <td
                        key={c.key}
                        data-label={label}
                        className={`${pad} ${c.align === 'right' ? 'text-right' : ''} ${
                          c.hideBelow ? HIDE_BELOW[c.hideBelow] : ''
                        } ${c.className ?? ''}`}
                      >
                        {c.cell(row)}
                      </td>
                    );
                  })}
                </tr>
                {expanded && (
                  <tr className="border-t border-surface-border bg-surface/40">
                    <td colSpan={columns.length} className="p-3">
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
