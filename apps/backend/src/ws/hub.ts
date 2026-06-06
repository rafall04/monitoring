import type { FastifyInstance } from 'fastify';
import websocket, { type SocketStream } from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { createRedis, prisma } from '@noc/server';
import {
  REDIS_CHANNELS,
  canAccessSite,
  siteIdFromChannel,
  type Role,
  type WsClientEvent,
  type WsServerEvent,
} from '@noc/shared';

/**
 * WebSocket hub. Clients connect to /ws?token=<accessJWT>, then send
 * { type: 'subscribe', siteId } to join a per-site room. The worker/backend
 * publish events to Redis; we fan them out to the sockets in the matching room.
 */
export async function registerWebsocketHub(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  const rooms = new Map<string, Set<WebSocket>>();
  const sub = createRedis('backend-sub');
  await sub.psubscribe(REDIS_CHANNELS.siteEventsPattern);

  sub.on('pmessage', (_pattern, channel, message) => {
    const siteId = siteIdFromChannel(channel);
    if (!siteId) return;
    const room = rooms.get(siteId);
    if (!room) return;
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  });

  const join = (siteId: string, ws: WebSocket) => {
    let room = rooms.get(siteId);
    if (!room) {
      room = new Set();
      rooms.set(siteId, room);
    }
    room.add(ws);
  };
  const leave = (siteId: string, ws: WebSocket) => rooms.get(siteId)?.delete(ws);

  const send = (ws: WebSocket, ev: WsServerEvent) => ws.send(JSON.stringify(ev));

  app.get('/ws', { websocket: true }, async (connection: SocketStream, req) => {
    const ws = connection.socket;
    const token = (req.query as { token?: string })?.token;

    let user: { role: Role; scopeSiteIds: string[] } | null = null;
    try {
      if (!token) throw new Error('missing token');
      const payload = app.jwt.verify(token) as { sub: string };
      const u = await prisma.appUser.findUnique({ where: { id: payload.sub } });
      if (!u || !u.isActive) throw new Error('inactive');
      user = { role: u.role as Role, scopeSiteIds: (u.scopeSiteIds as string[]) ?? [] };
    } catch {
      send(ws, { type: 'error', message: 'unauthorized' });
      ws.close(1008, 'unauthorized');
      return;
    }

    const joined = new Set<string>();

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
        if (!user || !canAccessSite(user, msg.siteId)) {
          send(ws, { type: 'error', message: 'no access to site' });
          return;
        }
        join(msg.siteId, ws);
        joined.add(msg.siteId);
        send(ws, { type: 'subscribed', siteId: msg.siteId });
      } else if (msg.type === 'unsubscribe') {
        leave(msg.siteId, ws);
        joined.delete(msg.siteId);
      }
    });

    ws.on('close', () => {
      for (const siteId of joined) leave(siteId, ws);
      joined.clear();
    });
  });

  app.addHook('onClose', async () => {
    await sub.quit().catch(() => undefined);
  });
}
