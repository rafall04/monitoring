'use client';

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
  // blue-500 when no admin has customized it.
  primary: 'bg-accent text-white hover:opacity-90',
  secondary:
    'bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600',
  danger: 'bg-red-600 hover:bg-red-500 text-white',
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
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-surface-border bg-surface-raised ${className}`}>
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
  'w-full rounded-md border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-blue-500';

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
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ color: STATUS_COLORS[status], border: `1px solid ${STATUS_COLORS[status]}55` }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[status] }} />
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
  default: 'max-w-6xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
} as const;
export type PageWidth = keyof typeof PAGE_WIDTHS;

/** Full-height column: a fixed header on top, a single scrolling body below. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col">{children}</div>;
}

/**
 * Sticky page header bar (stays put while the body scrolls). Title + optional
 * subtitle on the left; optional `actions` (tabs, filters, buttons) on the
 * right. `width` matches PageBody so the title aligns with the content column.
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
        className={`mx-auto flex w-full ${PAGE_WIDTHS[width]} flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 sm:px-6`}
      >
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-slate-100">{title}</h1>
          {subtitle && <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
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
        className={`mx-auto w-full ${PAGE_WIDTHS[width]} space-y-6 px-5 py-5 sm:px-6 sm:py-6 ${className}`}
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
      className={`inline-flex overflow-hidden rounded-md border border-surface-border text-xs font-medium ${className}`}
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={`px-3 py-1.5 ${
            value === t.value
              ? 'bg-accent text-white'
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
