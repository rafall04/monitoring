---
name: realtime
description: Rantai realtime end-to-end — publish Redis noc:site:<id>:events → WS hub psubscribe + room fanout → frontend useSiteSocket + applyWsEvent cache-patch; auth subprotocol 'bearer', nama channel hanya dari events.ts, dan resep event baru
argument-hint: "[topik: event|ws|channel]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: Realtime (Redis → WS hub → TanStack cache)

## Rantai lengkap

```
status-engine / producers            apps/backend/src/ws/hub.ts        apps/frontend
─────────────────────                ─────────────────────            ─────────────
publishSiteEvent(redis,              sub.psubscribe(                   lib/ws.ts
  siteId, ev /*WsServerEvent*/)      'noc:site:*:events')              useSiteSocket(siteId)
        │                                  │                                 │
        └── channel noc:site:<id>:events ──┤ pmessage → siteIdFromChannel     │ 'subscribe'
                                           │ → rooms[siteId] sockets         │ WS → 'bearer', JWT
                                           │ → ws.send(JSON.stringify(ev))   │
                                           └────────────────▶ lib/queries.ts
                                                              applyWsEvent → patch
                                                              cache per-device
```

## Aturan keras

- **Nama channel/key HANYA dari `REDIS_CHANNELS`/`REDIS_KEYS` di `packages/shared/src/events.ts`** — jangan hardcode `noc:` di mana pun.
- **Kontrak event = `WsServerEvent`/`WsClientEvent`** di shared — produsen & konsumen sepakat lewat union type itu; event baru harus masuk union dulu.
- **Auth WS**: client menawarkan `['bearer', accessToken]` via `Sec-WebSocket-Protocol`; server `handleProtocols` menjawab HANYA `'bearer'` (jangan echo token). **`?token=` dilarang** — masuk log proxy/request.
- **Subscribe dicek ulang**: tiap `{type:'subscribe',siteId}` diverifikasi `canAccessSite` dengan snapshot user fresh — jangan cache hasil auth lintas event.
- **`sendRaw`**: cek `readyState===OPEN` DI DALAM try — readyState bisa flip antara cek dan send.
- **Sweep liveness**: hub ping/pong menandai `alive`; socket mati dibersihkan dari `rooms`/`sessions`.
- **Fanout per site saja** — event tidak boleh bocor lintas room site (scope = kunci room).
- **Frontend**: patch cache lewat `applyWsEvent` per-entitas — jangan `invalidateQueries` kasar untuk event rutin (refetch storm).

## Resep: tipe event baru

1. Tambah varian di union `WsServerEvent` (`shared/types.ts` atau file event contract terkait).
2. Produsen: `publishSiteEvent(redisPub, siteId, {type:'x.y', siteId, ...})` — titik publikasi biasanya status-engine/service, bukan route handler langsung.
3. Frontend: cabang `applyWsEvent` di `lib/queries.ts` → update cache query relevan (setQueryData per-entitas, bukan invalidate global).
4. Bila event juga perlu toast/notif UI → hook di komponen yang subscribe.
5. Typecheck: shared → backend → frontend (`npm run typecheck`).

## Diagnosis cepat

- "Marker tidak live-update": WS connected? (network tab → /ws → status `101` + subprotocol `bearer`); hub `psubscribe` error? event masuk `noc:site:*`? (`redis-cli PSUBSCRIBE 'noc:site:*:events'`); `applyWsEvent` punya cabang tipe itu?
- "Socket kebuka tapi kosong": `subscribe` ditolak scope → cek `scopeSiteIds` user vs siteId; user di-deactivate → sweep menutup socket.
- Proxy produksi: ingress butuh `Path ^/ws` → backend:3320 DI ATAS catch-all (deploy.sh mencetak hint ini).
