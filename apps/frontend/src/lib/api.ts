import type { AppUserPublic } from '@noc/shared';

// Resolve the API base. In the BROWSER we always use a same-origin relative URL:
// the Next.js server rewrites /api/* and /uploads/* to the backend (see
// next.config.mjs), so there is no CORS and NO separate public "api-" domain is
// required — one hostname (or a bare IP) serves the whole app. On the server
// (SSR/build) we reach the backend directly over the internal Docker network.
function apiBase(): string {
  if (typeof window !== 'undefined') return '';
  return (
    process.env.BACKEND_ORIGIN ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    'http://localhost:4000'
  );
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
// ---- auth state sync ---------------------------------------------------------
// Token storage lives in localStorage but React state lives in AuthProvider.
// tryRefresh() rewrites the stored snapshot out-of-band (a refresh response
// carries a fresh user — role/scope may have changed server-side), so listeners
// are notified to keep the context in step without a full page reload.
const authListeners = new Set<(u: AppUserPublic | null) => void>();
export function onAuthChange(cb: (u: AppUserPublic | null) => void): () => void {
  authListeners.add(cb);
  return () => {
    authListeners.delete(cb);
  };
}
function notifyAuthChange(u: AppUserPublic | null): void {
  for (const cb of authListeners) {
    try {
      cb(u);
    } catch {
      /* listener errors must not break the request path */
    }
  }
}

export function setStoredUser(user: AppUserPublic): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  notifyAuthChange(user);
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
  notifyAuthChange(null);
}

// ---- forced logout -----------------------------------------------------------
// Concurrent 401s can all decide the session is dead at once — guard so only
// the first performs the redirect (the navigation unloads the page anyway).
let loggingOut = false;
export function redirectToLogin(): void {
  if (typeof window === 'undefined' || loggingOut) return;
  loggingOut = true;
  // Already on the login page — keep the URL as-is (it may carry its own
  // ?next= already; wrapping it again would nest the param).
  if (window.location.pathname === '/login') return;
  // Preserve the deep link so the user lands back where they were.
  const here = window.location.pathname + window.location.search;
  window.location.href = `/login?next=${encodeURIComponent(here)}`;
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

async function doRefresh(): Promise<boolean> {
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

// Single-flight refresh: the backend ROTATES the refresh token on every call,
// so a burst of concurrent 401s must share one request — parallel refreshes
// race, the losers land on the just-revoked token, and everyone gets logged out.
let refreshPromise: Promise<boolean> | null = null;
export function tryRefresh(): Promise<boolean> {
  refreshPromise ??= doRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

// 401 on these endpoints is an expected answer (bad credentials, dead refresh
// token) — not an expired session to recover from. Anything else under /auth/
// (e.g. /auth/me, /auth/change-password) DOES go through the refresh retry.
const AUTH_401_EXEMPT = new Set(['/auth/login', '/auth/refresh', '/auth/logout']);

async function request<T>(path: string, init: RequestInit, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  const token = getAccessToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  const res = await fetch(`${apiBase()}/api/v1${path}`, { ...init, headers });

  if (res.status === 401 && retry && !AUTH_401_EXEMPT.has(path.split('?')[0] ?? path)) {
    if (await tryRefresh()) return request<T>(path, init, false);
    clearAuth();
    redirectToLogin();
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
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),
};
