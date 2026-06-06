'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppUserPublic, Permission } from '@noc/shared';
import { hasPermission } from '@noc/shared';
import {
  api,
  clearAuth,
  getRefreshToken,
  getStoredUser,
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
