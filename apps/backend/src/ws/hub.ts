import type { FastifyInstance } from 'fastify';
import websocket, { type SocketStream } from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { createRedis, prisma } from '@noc/server';
import {
  REDIS_CHANNELS,
  canAccessSite,
  siteIdFromChannel,
  type Role,
  type ScopedUser,
  type WsClientEvent,
  type WsServerEvent,
} from '@noc/shared';

/** Per-socket state tracked server-side for liveness + revalidation. */
interface WsSession {
  /** Owner's user id — re-fetched on every subscribe and every sweep. */
  userId: string;
  /** Site rooms this socket currently occupies. */
  joined: Set<string>;
  /** Flipped false before each server ping, true when a pong arrives. */
  alive: boolean;
}

/**
 * WebSocket hub. Clients connect to /ws?token=<accessJWT>, then send
 * { type: 'subscribe', siteId } to join a per-site room. The worker/backend
 * publish events to Redis; we fan them out to the sockets in the matching room.
 */
export async function registerWebsocketHub(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  const rooms = new Map<string, Set<WebSocket>>();
  const sessions = new Map<WebSocket, WsSession>();
  const sub = createRedis('backend-sub'); // carries an 'error' listener from createRedis
  await sub.psubscribe(REDIS_CHANNELS.siteEventsPattern);

  const sendRaw = (ws: WebSocket, data: string): void => {
    try {
      // readyState can flip to CLOSED/CLOSING between a caller's check and the
      // send itself — keep the check INSIDE the try so the race can't throw.
      if (ws.readyState === ws.OPEN) ws.send(data);
    } catch (err) {
      app.log.warn({ err }, 'ws send failed');
    }
  };
  const send = (ws: WebSocket, ev: WsServerEvent): void => sendRaw(ws, JSON.stringify(ev));

  sub.on('pmessage', (_pattern, channel, message) => {
    const siteId = siteIdFromChannel(channel);
    if (!siteId) return;
    const room = rooms.get(siteId);
    if (!room) return;
    for (const ws of room) sendRaw(ws, message);
  });

  const join = (siteId: string, ws: WebSocket) => {
    let room = rooms.get(siteId);
    if (!room) {
      room = new Set();
      rooms.set(siteId, room);
    }
    room.add(ws);
  };
  const leave = (siteId: string, ws: WebSocket) => {
    const room = rooms.get(siteId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) rooms.delete(siteId); // drop empty rooms
  };
  const cleanup = (ws: WebSocket) => {
    const s = sessions.get(ws);
    if (!s) return;
    for (const siteId of s.joined) leave(siteId, ws);
    s.joined.clear();
    sessions.delete(ws);
  };

  /** Fresh authorization snapshot for a session's user. null = gone/inactive. */
  const loadScope = async (userId: string): Promise<ScopedUser | null> => {
    const u = await prisma.appUser.findUnique({
      where: { id: userId },
      select: { isActive: true, role: true, scopeSiteIds: true },
    });
    if (!u || !u.isActive) return null;
    return { role: u.role as Role, scopeSiteIds: (u.scopeSiteIds as string[]) ?? [] };
  };

  const closeUnauthorized = (ws: WebSocket) => {
    send(ws, { type: 'error', message: 'unauthorized' });
    try {
      ws.close(1008, 'unauthorized');
    } catch {
      /* already gone */
    }
    cleanup(ws);
  };

  // Server-side keepalive: ping every ~30s; a socket that missed the previous
  // pong is a dead half-open connection — terminate it so rooms don't leak.
  const pingTimer = setInterval(() => {
    for (const [ws, s] of sessions) {
      if (!s.alive) {
        cleanup(ws);
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      s.alive = false;
      try {
        if (ws.readyState === ws.OPEN) ws.ping();
      } catch {
        cleanup(ws);
      }
    }
  }, 30_000);
  pingTimer.unref?.();

  // Periodic revalidation: the user snapshot taken at connect goes stale while
  // the socket lives — close sockets whose user was deactivated, and drop room
  // memberships a shrunken site scope no longer permits.
  const revalidateTimer = setInterval(() => {
    void (async () => {
      for (const [ws, s] of sessions) {
        try {
          const scoped = await loadScope(s.userId);
          if (!scoped) {
            closeUnauthorized(ws);
            continue;
          }
          for (const siteId of [...s.joined]) {
            if (!canAccessSite(scoped, siteId)) {
              leave(siteId, ws);
              s.joined.delete(siteId);
            }
          }
        } catch (err) {
          app.log.warn({ err }, 'ws session revalidation failed');
        }
      }
    })().catch((err) => app.log.warn({ err }, 'ws revalidation sweep failed'));
  }, 60_000);
  revalidateTimer.unref?.();

  app.get('/ws', { websocket: true }, async (connection: SocketStream, req) => {
    const ws = connection.socket;
    const token = (req.query as { token?: string })?.token;

    let userId: string;
    try {
      if (!token) throw new Error('missing token');
      const payload = app.jwt.verify(token) as { sub: string };
      const u = await prisma.appUser.findUnique({ where: { id: payload.sub } });
      if (!u || !u.isActive) throw new Error('inactive');
      userId = u.id;
    } catch {
      send(ws, { type: 'error', message: 'unauthorized' });
      ws.close(1008, 'unauthorized');
      return;
    }

    const session: WsSession = { userId, joined: new Set(), alive: true };
    sessions.set(ws, session);

    ws.on('message', (raw) => {
      let msg: WsClientEvent;
      try {
        msg = JSON.parse(raw.toString()) as WsClientEvent;
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
      } else if (msg.type === 'subscribe') {
        const siteId = msg.siteId;
        // Re-fetch the user per subscribe instead of trusting the connect-time
        // snapshot — a deactivated account or shrunken scope takes effect on
        // the next message, not on reconnect.
        void (async () => {
          const scoped = await loadScope(session.userId);
          if (!scoped) {
            closeUnauthorized(ws);
            return;
          }
          if (!canAccessSite(scoped, siteId)) {
            send(ws, { type: 'error', message: 'no access to site' });
            return;
          }
          join(siteId, ws);
          session.joined.add(siteId);
          send(ws, { type: 'subscribed', siteId });
        })().catch((err) => app.log.warn({ err }, 'ws subscribe failed'));
      } else if (msg.type === 'unsubscribe') {
        leave(msg.siteId, ws);
        session.joined.delete(msg.siteId);
      }
    });

    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('error', (err) => {
      // Log + same cleanup as 'close' (a 'close' event normally follows; the
      // cleanup is idempotent either way).
      app.log.warn({ err }, 'ws connection error');
      cleanup(ws);
    });
    ws.on('close', () => cleanup(ws));
  });

  app.addHook('onClose', async () => {
    clearInterval(pingTimer);
    clearInterval(revalidateTimer);
    for (const ws of sessions.keys()) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    sessions.clear();
    rooms.clear();
    await sub.quit().catch(() => undefined);
  });
}
