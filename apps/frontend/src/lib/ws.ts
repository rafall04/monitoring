'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsServerEvent } from '@noc/shared';
import { clearAuth, getAccessToken, redirectToLogin, tryRefresh } from './api';
import { qk } from './queries';

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
 * Returns `connected` — true once the server confirmed the room join
 * ('subscribed'), false while down/reconnecting — so the UI can flag the map
 * as stale instead of silently freezing.
 */
export function useSiteSocket(
  siteId: string | undefined,
  onEvent: (event: WsServerEvent) => void,
): boolean {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // Liveness bookkeeping: ANY inbound frame (site event or pong) counts.
    let lastHeard = 0;
    let lastPing = 0;

    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };

    const connect = () => {
      const token = getAccessToken();
      if (!token) return;
      // The token is sent as a Sec-WebSocket-Protocol offer (the server picks
      // 'bearer') — never as ?token=, which lands in request/proxy logs.
      socket = new WebSocket(wsUrl(), ['bearer', token]);

      socket.onopen = () => {
        attempts = 0;
        lastHeard = Date.now();
        lastPing = 0;
        socket?.send(JSON.stringify({ type: 'subscribe', siteId }));
        // Heartbeat: ping every ~30s on a 10s tick; the server answers
        // {type:'pong'}. A ping unanswered for ~10s means the socket is a
        // half-open zombie (NAT/proxy silently dropped it) — close it so
        // onclose drives the normal reconnect/backoff path.
        stopHeartbeat();
        heartbeat = setInterval(() => {
          const s = socket;
          if (!s || s.readyState !== WebSocket.OPEN) return;
          if (lastPing > lastHeard && Date.now() - lastPing > 10_000) {
            s.close();
            return;
          }
          if (Date.now() - lastPing >= 30_000) {
            lastPing = Date.now();
            try {
              s.send(JSON.stringify({ type: 'ping' }));
            } catch {
              s.close();
            }
          }
        }, 10_000);
      };
      socket.onmessage = (ev) => {
        lastHeard = Date.now();
        try {
          const msg = JSON.parse(ev.data as string) as WsServerEvent;
          if (msg.type === 'subscribed') {
            setConnected(true);
            // Resync on (re)join: pull fresh state so changes that happened
            // while the socket was down are caught up — the event stream only
            // covers what happens from this point on.
            void qc.invalidateQueries({ queryKey: qk.siteDevices(siteId) });
            void qc.invalidateQueries({ queryKey: qk.siteSummary(siteId) });
          }
          cbRef.current(msg);
        } catch {
          /* ignore malformed */
        }
      };
      socket.onclose = (event) => {
        stopHeartbeat();
        setConnected(false);
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
          void tryRefresh().then((ok) => {
            if (closed) return;
            if (!ok) {
              // The refresh token is dead too — the session is over. Bail to
              // login instead of reconnecting forever with a dead token.
              clearAuth();
              redirectToLogin();
              return;
            }
            timer = setTimeout(connect, delay);
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
      stopHeartbeat();
      if (timer) clearTimeout(timer);
      setConnected(false);
      socket?.close();
    };
  }, [siteId, qc]);

  return connected;
}
