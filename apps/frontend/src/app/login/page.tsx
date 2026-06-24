'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useBranding } from '@/lib/branding';

export default function LoginPage() {
  const { login } = useAuth();
  const branding = useBranding();
  const router = useRouter();
  const [email, setEmail] = useState('admin@noc.local');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface px-4 py-10">
      {/* Aurora background — accent-tinted blurred blobs, theme-aware via --accent */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 -top-28 h-96 w-96 animate-pulse rounded-full bg-accent/25 blur-3xl" />
        <div className="absolute -bottom-32 -right-20 h-[30rem] w-[30rem] rounded-full bg-accent/15 blur-3xl" />
        <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-500/10 blur-3xl" />
        {/* faint dotted grid for depth */}
        <div
          className="absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage: 'radial-gradient(rgb(148 163 184 / 0.5) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
      </div>

      <div className="relative z-10 w-full max-w-md animate-[fadeIn_0.5s_ease-out]">
        {/* Brand header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/15 shadow-lg shadow-accent/10 ring-1 ring-accent/30">
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt="" className="h-12 w-12 rounded-xl object-contain" />
            ) : (
              <span className="text-2xl font-black tracking-tight text-accent">
                {initials(branding.orgName)}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">{branding.orgName}</h1>
          <p className="mt-1 text-sm text-slate-400">Network Operations Center</p>
        </div>

        {/* Glass card */}
        <div className="rounded-2xl border border-surface-border bg-surface-raised/70 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
          <h2 className="text-lg font-semibold text-slate-100">Selamat datang kembali</h2>
          <p className="mb-5 mt-1 text-sm text-slate-400">Masuk untuk melanjutkan ke dashboard.</p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Email
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                  <MailIcon />
                </span>
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-surface-border bg-surface/80 py-2.5 pl-10 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-accent focus:ring-2 focus:ring-accent/30"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Password
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                  <LockIcon />
                </span>
                <input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-surface-border bg-surface/80 py-2.5 pl-10 pr-10 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-accent focus:ring-2 focus:ring-accent/30"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Sembunyikan password' : 'Tampilkan password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-500 transition hover:text-slate-300"
                >
                  {showPw ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-white shadow-lg shadow-accent/25 transition hover:opacity-95 hover:shadow-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <>
                  <Spinner /> Memproses…
                </>
              ) : (
                'Masuk'
              )}
            </button>
          </form>
        </div>

        {/* Copyright */}
        <p className="mt-6 text-center text-xs text-slate-500">
          © {new Date().getFullYear()} <span className="font-medium text-slate-400">RAF</span>. All rights reserved.
        </p>
      </div>
    </div>
  );
}

/** Up to two initials from the org name, for the logo fallback badge. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0] ?? '';
  const b = parts[1] ?? '';
  if (!a) return '·';
  if (!b) return a.slice(0, 2).toUpperCase();
  return (a.charAt(0) + b.charAt(0)).toUpperCase();
}

function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 5L2 7" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <path d="M6.61 6.61A18.5 18.5 0 0 0 2 12s3.5 7 10 7a9.12 9.12 0 0 0 5.39-1.61" />
      <path d="m2 2 20 20" />
    </svg>
  );
}
function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />;
}
