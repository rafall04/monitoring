'use client';

import { useEffect, useRef } from 'react';
import type { WsServerEvent } from '@noc/shared';
import { getAccessToken } from './api';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';

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
      socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

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
      socket.onclose = () => {
        if (closed) return;
        attempts++;
        timer = setTimeout(connect, Math.min(10000, 1000 * attempts));
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
