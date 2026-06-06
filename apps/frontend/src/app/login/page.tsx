'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { Button, Card, Field, TextInput } from '@/components/ui';

export default function LoginPage() {
  const { login } = useAuth();
  const branding = useBranding();
  const router = useRouter();
  const [email, setEmail] = useState('admin@noc.local');
  const [password, setPassword] = useState('');
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
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-4 flex items-center gap-3">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logoUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded object-contain"
            />
          ) : (
            <span aria-hidden className="h-10 w-10 shrink-0 rounded bg-accent" />
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-slate-100">{branding.orgName}</h1>
            <p className="text-sm text-slate-400">Sign in to continue</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Email">
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password">
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
