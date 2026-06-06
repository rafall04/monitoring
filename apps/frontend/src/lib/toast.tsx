'use client';

// =============================================================================
// Tiny global Toast + Confirm primitives.
//
//   const toast = useToast();
//   toast.ok('Tersimpan');
//   toast.error('Gagal:', e.message);
//
//   const confirmAction = useConfirm();
//   if (await confirmAction({ title: 'Delete device?', danger: true })) ...
//
// No dependencies; lives at the root via <ToastProvider> in providers.tsx.
// =============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type ToastKind = 'ok' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  ok: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

interface PromptState extends PromptOptions {
  resolve: (v: string | null) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);
const ConfirmCtx = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null);
const PromptCtx = createContext<((o: PromptOptions) => Promise<string | null>) | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast: missing <ToastProvider>');
  return ctx;
}

export function useConfirm(): (o: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm: missing <ToastProvider>');
  return ctx;
}

export function usePrompt(): (o: PromptOptions) => Promise<string | null> {
  const ctx = useContext(PromptCtx);
  if (!ctx) throw new Error('usePrompt: missing <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((t) => [...t, { id, kind, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      ok: (m) => push('ok', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );

  const ask = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setConfirm({ ...opts, resolve });
      }),
    [],
  );
  const askPrompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setPromptValue(opts.defaultValue ?? '');
        setPrompt({ ...opts, resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    confirm?.resolve(ok);
    setConfirm(null);
  };
  const closePrompt = (value: string | null) => {
    prompt?.resolve(value);
    setPrompt(null);
    setPromptValue('');
  };

  return (
    <ToastCtx.Provider value={api}>
      <ConfirmCtx.Provider value={ask}>
        <PromptCtx.Provider value={askPrompt}>
        {children}

        {/* Toasts — top-right, stacked */}
        <div className="pointer-events-none fixed right-4 top-4 z-[10000] flex w-80 flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 rounded border px-3 py-2 text-sm shadow-lg backdrop-blur ${
                t.kind === 'ok'
                  ? 'border-emerald-800 bg-emerald-950/80 text-emerald-200'
                  : t.kind === 'error'
                    ? 'border-red-800 bg-red-950/80 text-red-200'
                    : 'border-slate-700 bg-surface-raised/90 text-slate-200'
              }`}
            >
              <span className="flex-1 whitespace-pre-wrap">{t.message}</span>
              <button
                className="text-xs opacity-60 hover:opacity-100"
                onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Confirm modal */}
        {confirm && (
          <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-sm rounded-lg border border-surface-border bg-surface-raised p-5 shadow-2xl">
              <h3 className="text-base font-semibold text-slate-100">{confirm.title}</h3>
              {confirm.body && (
                <p className="mt-2 text-sm text-slate-400 whitespace-pre-wrap">{confirm.body}</p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                  onClick={() => close(false)}
                >
                  {confirm.cancelLabel ?? 'Cancel'}
                </button>
                <button
                  className={`rounded px-3 py-1.5 text-sm font-medium text-white ${
                    confirm.danger
                      ? 'bg-red-600 hover:bg-red-500'
                      : 'bg-accent hover:opacity-90'
                  }`}
                  onClick={() => close(true)}
                >
                  {confirm.confirmLabel ?? (confirm.danger ? 'Delete' : 'OK')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Prompt modal (text input) */}
        {prompt && (
          <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4">
            <form
              onSubmit={(e) => { e.preventDefault(); closePrompt(promptValue || null); }}
              className="w-full max-w-sm rounded-lg border border-surface-border bg-surface-raised p-5 shadow-2xl"
            >
              <h3 className="text-base font-semibold text-slate-100">{prompt.title}</h3>
              {prompt.label && (
                <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400">
                  {prompt.label}
                </label>
              )}
              <input
                autoFocus
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder={prompt.placeholder}
                className="mt-2 w-full rounded border border-surface-border bg-surface px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-accent"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                  onClick={() => closePrompt(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                >
                  {prompt.confirmLabel ?? 'OK'}
                </button>
              </div>
            </form>
          </div>
        )}
        </PromptCtx.Provider>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}
