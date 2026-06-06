# MikroTik NOC — Monitoring & Hotspot Management

An all-in-one Network Operations Center for fleets of MikroTik routers spread
across many sites. Status comes from **RouterOS Netwatch** (the server does **no**
ICMP scanning), is visualised on a **per-site map** (geographic *or* an uploaded
factory floorplan — one Leaflet engine for both), and devices can be placed/edited
right on the map. Hotspot users, profiles, vouchers and live sessions are managed
from the web. Access is controlled by 3 roles with per-site scoping.

> Status of this build: the **monitoring spine is implemented deeply**
> (auth + RBAC + site scoping, Company/Site/Router/Device CRUD, Netwatch webhook +
> polling worker, Redis pub/sub, WebSocket, and the Leaflet map with live markers
> and drag-to-edit). Hotspot, reports and admin screens are functional but lighter.
> RouterOS **v6 (binary API)** is implemented; a **v7 REST** adapter slots in
> behind the same interface (`packages/server/src/mikrotik`).

---

## Architecture

```
                          ┌────────────────────┐
   Browser ──HTTP/WS──►   │  Caddy (:8080)     │
                          └─────┬───────┬──────┘
                                │       │
                 /,/_next       │       │  /api/* , /ws , /uploads/*
                                ▼       ▼
                       ┌───────────┐  ┌──────────────────────┐
                       │ frontend  │  │ backend (Fastify)    │
                       │ Next.js   │  │ REST + WebSocket hub │
                       └───────────┘  └───────┬──────────────┘
                                              │ publish/subscribe
   MikroTik ──Netwatch webhook──► backend     │
       ▲                                       ▼
       │ binary API (poll/install)        ┌─────────┐
       └──────────────────────────────────┤  Redis  │  pub/sub + status cache
                       ┌──────────────────►└─────────┘
                       │                        ▲
                 ┌─────┴──────┐                 │
                 │  worker    │── reads /tool/netwatch, applies status,
                 │ (poller)   │   refreshes resource, publishes events
                 └─────┬──────┘
                       ▼
                  ┌──────────┐
                  │ Postgres │  (Prisma)
                  └──────────┘
```

**Why split processes?** Next.js (serverless/edge) is unsuitable for long-lived
TCP connections to routers, background polling, or hosting a WebSocket server. The
backend + worker are long-running Node processes; the worker can be scaled
horizontally (router sharding via Redis-coordinated config).

### Realtime flow
MikroTik (webhook **or** worker poll) → **status-engine** writes the change +
`StatusEvent`, updates the Redis cache, and **publishes** to `noc:site:<id>:events`
→ backend **WebSocket hub** fans out to clients subscribed to that site → the map
updates **one marker** (no full re-render).

---

## Repository layout

```
packages/
  shared/      Isomorphic types, zod schemas, RBAC matrix, WS event contracts
  server/      Node-only: Prisma client, AES-256-GCM crypto, Redis, logger,
               MikroTik client (v6 adapter behind an interface), Netwatch
               script generator, status-engine. Prisma schema + seed live here.
apps/
  backend/     Fastify REST API + WebSocket hub, JWT auth, RBAC + site scoping,
               Netwatch webhook receiver, audit log, uploads.
  worker/      Netwatch poller + reconciliation, circuit breaker, resource refresh.
  frontend/    Next.js (App Router) + Tailwind + TanStack Query + Leaflet.
docs/          Netwatch integration guide & ready-to-use scripts.
docker-compose.yml, Caddyfile, .env.example
```

---

## Tech stack & key decisions

- **Backend:** Fastify (lightweight, great plugin ecosystem) + `@fastify/websocket`.
- **DB/ORM:** PostgreSQL + Prisma. **Cache/PubSub:** Redis (ioredis).
- **MikroTik:** `node-routeros` (v6 binary API). v7 REST is a future adapter.
- **Frontend:** Next.js App Router, Leaflet + react-leaflet (geo via OSM tiles,
  floorplan via `L.CRS.Simple` + `ImageOverlay`), TanStack Query, Tailwind (dark).
- **Auth:** JWT access (15m) + rotating opaque refresh tokens (hashed at rest).
  Password hashing uses **bcryptjs** (pure-JS; swap to argon2 where a native
  toolchain is available — see *Assumptions*).
- **Run model:** Node services run TypeScript directly via **tsx** (no separate
  build step); the frontend uses `next build`/`next start`.

---

## Deploy to production (Ubuntu 20.04+, one command)

On a fresh server, clone and run the installer. It installs Docker (if missing),
generates `.env` with fresh secrets, builds the images, and starts the whole
stack (Postgres + Redis + backend + worker + frontend):

```bash
git clone https://github.com/rafall04/monitoring.git
cd monitoring
sudo ./deploy.sh        # interactive — just answer the prompts
```

It asks five things on **every** run (press Enter to keep the current value, so
the **ports are always customizable**):

1. **IP server** — auto-detected default.
2. **Domain frontend** — blank = access via IP.
3. **Domain backend/API** — blank = serve the API under the frontend domain (`/api`).
4. **Port frontend / web** — default **3600**.
5. **Port backend / API** — default **3500**.

…then **HTTPS?** if a domain was entered. The apps are **always** published on the
two ports (direct access at `http://IP:port`); when a domain is set a bundled
**Caddy** reverse proxy also serves it (auto **Let's Encrypt** TLS with HTTPS),
and CORS is whitelisted to the frontend domain **+** the IP:port.

| Inputs | Result |
| --- | --- |
| IP only | `http://IP:3600` (web) + `http://IP:3500` (api) |
| frontend domain | `https://sf.raf.my.id` (API under `/api`) — apps also on IP:port |
| frontend **+** backend domain | `https://sf.raf.my.id` + `https://api.sf.raf.my.id` (split; CORS whitelists frontend) |

Same via flags (automation), e.g. `sudo ./deploy.sh --ip 172.17.11.12
--frontend-domain sf.raf.my.id --backend-domain api.sf.raf.my.id --tls`. Use
`--yes` to skip prompts and reuse the saved config. TLS needs the domains public
+ ports 80/443 reachable for the ACME challenge.

Sign in with `admin@noc.local` / `ChangeMe123!` — **change it after the first
login** (or set `SUPER_ADMIN_PASSWORD` before the first run). The DB starts
**clean** (no demo data) unless you set `SEED_DEMO=true`; migrations + seed run
automatically.

Re-run `sudo ./deploy.sh …` with the **same flags** any time to update — it
rebuilds, restarts, and keeps your secrets. Open the firewall for the chosen
port(s).

```bash
docker compose logs -f      # tail logs   (add --profile proxy in proxy mode)
docker compose down         # stop everything
```

> Containers always listen on **4000** (backend) / **3000** (frontend)
> internally; the flags only change how they are exposed. The frontend bakes the
> backend URL at build time, so changing host/ports/mode rebuilds it automatically.

---

## Local development (without Docker)

You need a local **PostgreSQL** and **Redis** running, then:

```bash
cp .env.example .env          # set DATABASE_URL/REDIS_URL to your local hosts
npm install
npm run prisma:generate
npm run prisma:migrate        # creates the schema (dev)
SEED_DEMO=true npm run seed    # super_admin (+ demo data; omit SEED_DEMO for admin only)

npm run dev                   # backend :4000, worker :4100, frontend :3000
```

Open **http://localhost:3000**. In local dev the frontend talks to the backend
directly on `:4000` (the code default), so you don't need to set `NEXT_PUBLIC_*`.

Useful scripts (root `package.json`): `dev`, `dev:backend`, `dev:worker`,
`dev:frontend`, `build`, `typecheck`, `prisma:generate|migrate|deploy|studio`,
`seed`.

---

## Configuration (`.env`)

See `.env.example` for the full list. Highlights:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | Postgres + Redis connections |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | token signing |
| `CREDENTIALS_ENC_KEY` | base64 **32-byte** key for AES-256-GCM router secrets |
| `PUBLIC_BASE_URL` | public URL used when generating Netwatch scripts |
| `WEBHOOK_IP_ALLOWLIST` | optional CSV of router IPs allowed to hit the webhook |
| `POLL_INTERVAL_DEFAULT_SEC` | default worker poll interval |
| `WORKER_SHARD_COUNT` / `WORKER_SHARD_INDEX` | horizontal worker scaling |
| `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_WS_URL` | inlined into the frontend at **build** time |

---

## Adding a MikroTik router

1. **Admin → Sites & Routers**. Create a Company and a Site first if needed.
2. Add a router: host, API port (default `8728`, or `8729` with TLS), username,
   password (stored **encrypted**), RouterOS version (`v6`).
3. Click **Test** to verify connectivity — it shows identity + resource on success.
4. Add devices (host/IP must match the Netwatch `host`), or create them by clicking
   the map in Edit mode.

## Installing Netwatch scripts

See **[docs/netwatch-examples.md](docs/netwatch-examples.md)**. In short:

- **Copy/paste:** router row → **Netwatch script** → paste into the router.
- **Automatic:** tick *“Also create Netwatch entry”* when adding a device, or
  `POST /api/v1/routers/:id/netwatch/install` to (re)install for all devices.
- **Test it:** `curl -X POST ".../api/v1/webhook/netwatch?host=..&status=down&router_id=.." -H "X-Webhook-Token: .."`

## Configuring a site's map

- **Geo:** set the site to `geo`, choose center lat/lng + zoom. Markers use lat/lng
  over OpenStreetMap tiles.
- **Floorplan:** set the site to `floorplan`, then **Upload floorplan** (PNG/WebP/
  JPEG/SVG) with its pixel width/height. The image is shown via `ImageOverlay` on
  `L.CRS.Simple`; markers store `x/y` in image coordinates so they stay put across
  zoom/reload. (Store consistent dimensions if you replace the image later.)

Toggle **Edit** on the map to drag markers (saved with optimistic UI + a position
PATCH) and, with create permission, click empty space to add a device.

---

## Roles & permissions

Enforced **server-side** (middleware), not just hidden in the UI. Source of truth:
`packages/shared/src/rbac.ts`.

| Capability | user | operator | super_admin |
| --- | :--: | :--: | :--: |
| View map & device detail (scoped) | ✓ | ✓ | ✓ |
| Drag markers / edit position | | ✓ | ✓ |
| Edit device attributes | | ✓ | ✓ |
| Add devices | | ✓ | ✓ |
| Delete devices | | | ✓ |
| Hotspot view / manage users / disconnect | | ✓ | ✓ |
| Hotspot manage profiles | | | ✓ |
| Manage company/site/router + credentials | | | ✓ |
| Test connection / Netwatch install | | | ✓ |
| Manage app users & roles | | | ✓ |
| Scope | assigned sites | assigned sites | all sites |

---

## Security notes

- Router passwords encrypted at rest (AES-256-GCM); never sent to the browser.
- Webhook authenticated by a unique per-router token + optional IP allowlist.
- RBAC + site scoping enforced in the backend; audit log records sensitive actions.
- Uploaded SVGs are sanitised (scripts/handlers/`javascript:`/entities stripped).
  For high-assurance use, swap in DOMPurify + jsdom (`apps/backend/src/lib/uploads.ts`).
- Refresh tokens are rotated and stored hashed (sha256).

---

## Assumptions made (from the spec's open questions)

- **RouterOS:** v6 binary API implemented first; v7 REST is a drop-in adapter.
- **Tenancy:** company-aware multi-site; super_admin sees all companies/sites.
- **Operator deletes:** can add/edit devices, **cannot delete** (super_admin only).
- **Voucher card printing & Telegram/email:** out of scope for this pass
  (CSV export is included; notification hooks are env-flagged off).
- **Password hashing:** bcryptjs (pure-JS) to avoid native build toolchains on
  Windows; swap to argon2 in environments that can build it.

## Not yet implemented (good next steps)

- v7 REST MikroTik adapter; connection pooling/rate-limit tuning.
- Webhook dedup window in Redis (the status-engine already no-ops unchanged status).
- Voucher card PDF/printing; Telegram/email notifications; outgoing webhooks.
- Stale-status reconciliation (mark devices unknown when their router is long offline).
- Tests (unit/integration) and CI.
