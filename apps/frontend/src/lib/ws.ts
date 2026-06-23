'use client';

import { useEffect, useRef } from 'react';
import type { WsServerEvent } from '@noc/shared';
import { getAccessToken, tryRefresh } from './api';

// Resolve the WS URL at runtime. Next.js rewrites can't proxy WebSocket upgrades,
// so the socket must reach the backend directly:
//   - LAN/IP or localhost -> backend port on the same host (works on the LAN).
//   - Domain -> same-origin wss://<domain>/ws; the tunnel routes the /ws path to
//     the backend. If that path isn't configured, live updates are simply
//     unavailable — the rest of the app still works fully over HTTP.
function wsUrl(): string {
  if (typeof window === 'undefined') return process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000/ws';
  const host = window.location.hostname;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || host === '127.0.0.1') {
    return `ws://${host}:${process.env.NEXT_PUBLIC_BACKEND_PORT || '4000'}/ws`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

/**
 * Subscribe to a single site's realtime events. Reconnects with backoff and
 * re-subscribes on open. The callback ref is kept fresh without reconnecting.
 */
export function useSiteSocket(
  siteId: string | undefined,
  onEvent: (event: WsServerEvent) => void,
): void {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    if (!siteId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const token = getAccessToken();
      if (!token) return;
      socket = new WebSocket(`${wsUrl()}?token=${encodeURIComponent(token)}`);

      socket.onopen = () => {
        attempts = 0;
        socket?.send(JSON.stringify({ type: 'subscribe', siteId }));
      };
      socket.onmessage = (ev) => {
        try {
          cbRef.current(JSON.parse(ev.data as string) as WsServerEvent);
        } catch {
          /* ignore malformed */
        }
      };
      socket.onclose = (event) => {
        if (closed) return;
        attempts++;
        // Exponential backoff (1s→10s) with 50–100% jitter so many tabs don't
        // reconnect in lockstep after a backend blip (thundering herd).
        const base = Math.min(10000, 1000 * 2 ** Math.min(attempts - 1, 5));
        const delay = base * (0.5 + Math.random() / 2);
        // 1008 = the server rejected the upgrade as unauthorized (expired token).
        // A long-lived NOC tab whose only activity is this socket never triggers
        // an HTTP 401, so refresh the access token once before reconnecting —
        // otherwise it would loop forever with the same stale token.
        if (event.code === 1008) {
          void tryRefresh().finally(() => {
            if (!closed) timer = setTimeout(connect, delay);
          });
        } else {
          timer = setTimeout(connect, delay);
        }
      };
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [siteId]);
}
