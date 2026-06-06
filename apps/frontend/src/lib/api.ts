import type { AppUserPublic } from '@noc/shared';

// Resolve the API base at RUNTIME. When the app is opened via an IP/localhost
// (e.g. http://172.17.11.12:3310), talk to the backend on that same host:port so
// it works WITHOUT the public domain. Otherwise use the baked domain URL (e.g.
// https://api-sf.raf.my.id behind Cloudflare).
function apiBase(): string {
  const baked = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
  if (typeof window === 'undefined') return baked;
  const host = window.location.hostname;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:${process.env.NEXT_PUBLIC_BACKEND_PORT || '4000'}`;
  }
  return baked;
}

const ACCESS_KEY = 'noc_access';
const REFRESH_KEY = 'noc_refresh';
const USER_KEY = 'noc_user';

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACCESS_KEY);
}
export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(REFRESH_KEY);
}
export function setTokens(access: string, refresh: string): void {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}
export function setStoredUser(user: AppUserPublic): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function getStoredUser(): AppUserPublic | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppUserPublic;
  } catch {
    return null;
  }
}
export function clearAuth(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${apiBase()}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string; refreshToken: string; user: AppUserPublic };
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser(data.user);
    return true;
  } catch {
    return false;
  }
}

async function request<T>(path: string, init: RequestInit, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  const token = getAccessToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  const res = await fetch(`${apiBase()}/api/v1${path}`, { ...init, headers });

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await tryRefresh()) return request<T>(path, init, false);
    clearAuth();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, 'Session expired');
  }

  if (!res.ok) {
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    const message =
      (data as { message?: string })?.message ?? res.statusText ?? 'Request failed';
    throw new ApiError(res.status, message, data);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body != null ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),
};
