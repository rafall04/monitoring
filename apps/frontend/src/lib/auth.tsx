'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppUserPublic, Permission } from '@noc/shared';
import { hasPermission } from '@noc/shared';
import {
  api,
  clearAuth,
  getAccessToken,
  getRefreshToken,
  getStoredUser,
  onAuthChange,
  setStoredUser,
  setTokens,
} from './api';

interface AuthState {
  user: AppUserPublic | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<AppUserPublic>;
  logout: () => Promise<void>;
  /** Push an updated user snapshot (e.g. after self-service profile edit). */
  setUser: (u: AppUserPublic) => void;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

interface LoginResponse {
  user: AppUserPublic;
  accessToken: string;
  refreshToken: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUserPublic | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(getStoredUser());
    setReady(true);

    // The localStorage snapshot can be stale (role/scope changed by an admin,
    // or the account deactivated) — re-fetch once so the UI agrees with what
    // the backend will actually enforce. A 401 here flows through the api
    // client's refresh/relogin path on its own.
    if (getAccessToken()) {
      api
        .get<AppUserPublic>('/auth/me')
        .then((u) => {
          setStoredUser(u);
          setUser(u);
        })
        .catch(() => {
          /* network blip — keep the cached snapshot */
        });
    }
  }, []);

  // tryRefresh() (in lib/api) writes a fresh user snapshot on every token
  // rotation — mirror it into React state so role/scope changes take effect
  // without a reload.
  useEffect(() => onAuthChange((u) => setUser(u)), []);

  // Cross-tab sync: logout (or a login as a different user) in another tab is
  // invisible to this one without a storage listener. The Shell redirects to
  // /login as soon as `user` goes null.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'noc_user' || e.key === 'noc_access' || e.key === 'noc_refresh') {
        setUser(getStoredUser());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const login = async (email: string, password: string) => {
    const data = await api.post<LoginResponse>('/auth/login', { email, password });
    setTokens(data.accessToken, data.refreshToken);
    setStoredUser(data.user);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout', { refreshToken: getRefreshToken() });
    } catch {
      /* ignore */
    }
    clearAuth();
    setUser(null);
    if (typeof window !== 'undefined') window.location.href = '/login';
  };

  const can = (permission: Permission) =>
    user ? hasPermission(user.role, permission) : false;

  const replaceUser = (u: AppUserPublic) => {
    setStoredUser(u);
    setUser(u);
  };

  return (
    <AuthContext.Provider value={{ user, ready, login, logout, setUser: replaceUser, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
