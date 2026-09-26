# RAF NOC — Monitoring & Hotspot Management

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

   Producers ──LPUSH──► noc:wa:outbox (Redis list) ──BLPOP──► wabot ──► WhatsApp
   (status-engine, tickets, broadcast)                        (Baileys, 1 instance)
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
  wabot/       WhatsApp bot (Baileys) — alerts, self-service, complaint intake.
               Single instance only; consumes the Redis outbox, never sharded.
  frontend/    Next.js (App Router) + Tailwind + TanStack Query + Leaflet.
docs/          Netwatch integration guide, ready-to-use scripts, and the
               WhatsApp bot mega-plan (docs/whatsapp-bot-plan.md).
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
3. **Domain backend/API** — **optional.** The frontend reverse-proxies `/api`,
   `/ws` and `/uploads` to the backend (same-origin), so one hostname already
   serves the whole app. A backend domain is only whitelisted for direct access.
4. **Port frontend / web** — default **3600**.
5. **Port backend / API** — default **3500**.

…then **HTTPS?** if a domain was entered. The apps are **always** published on the
two ports (direct access at `http://IP:port`). Because the frontend proxies the
API to the backend over the internal network, the **browser only ever talks to
the frontend's own origin** — no CORS, and a separate public API domain is never
required. For a plain (non-Cloudflare) domain a bundled **Caddy** proxy serves it
with auto **Let's Encrypt** TLS; with `--cloudflare` no local proxy runs and you
expose a single tunnel hostname.

| Inputs | Result |
| --- | --- |
| IP only | `http://IP:3600` (web + API under `/api`, same origin) |
| frontend domain | `https://noc.example.com` (web + API under `/api`) — apps also on IP:port |
| `--cloudflare` | one tunnel hostname `noc.example.com -> localhost:3600`; login + API ride it |

Same via flags (automation), e.g. `sudo ./deploy.sh --ip 192.0.2.10
--frontend-domain noc.example.com --backend-domain api.noc.example.com --tls`. Use
`--yes` to skip prompts and reuse the saved config. TLS needs the domains public
+ ports 80/443 reachable for the ACME challenge.

The installer generates a random `SUPER_ADMIN_PASSWORD` (printed once in the
deploy summary; kept on re-runs — set it yourself before the first run to choose
it). Only the super-admin is always seeded — **change the password after first
login**:

| Login | Password | Role |
| --- | --- | --- |
| `admin@noc.local` | `$SUPER_ADMIN_PASSWORD` | super admin |

The demo accounts + sample data are opt-in via `SEED_DEMO=true` (in `.env`
before the first deploy, or inline with `npm run seed`):

| Login | Password | Role |
| --- | --- | --- |
| `operator@noc.local` | `operator123` | operator |
| `demo@noc.local` | `demo123` | viewer |

The DB starts **clean** (no demo data) unless you set `SEED_DEMO=true`; migrations
+ seed run automatically.

Re-run `sudo ./deploy.sh …` with the **same flags** any time to update — it
rebuilds, restarts, and keeps your secrets. Open the firewall for the chosen
port(s).

```bash
docker compose logs -f      # tail logs   (add --profile proxy in proxy mode)
docker compose down         # stop everything
```

> Containers always listen on **4000** (backend) / **3000** (frontend)
> internally; the flags only change how they are exposed. The frontend proxies
> `/api`, `/ws` and `/uploads` to `backend:4000` over the compose network
> (`BACKEND_ORIGIN`), so the browser stays same-origin regardless of host/port.

---

## Backup & restore

The `backup` service (`prodrigestivill/postgres-backup-local:16-alpine`) dumps
Postgres on a cron schedule — **daily** by default (`BACKUP_SCHEDULE` in `.env`
overrides) — into the `pg_backups` volume, plus once on every container start
(`BACKUP_ON_START=TRUE`). Dumps are gzipped plain SQL at
`/backups/{last,daily}/<DB>-*.sql.gz` with `-latest.sql.gz` symlinks; retention
is **7 daily dumps** (weekly/monthly rotation disabled via
`BACKUP_KEEP_WEEKS=0` / `BACKUP_KEEP_MONTHS=0`).

```bash
# List available dumps
docker compose exec backup ls -l /backups/daily

# Copy the newest dump off the host
docker compose exec backup cat "/backups/daily/${POSTGRES_DB:-noc}-latest.sql.gz" > dump.sql.gz
```

Restore the latest dump (destroys current data — stop writers first):

```bash
docker compose stop backend worker wabot
docker compose exec postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
docker compose exec -T backup sh -c 'gunzip -c /backups/daily/*-latest.sql.gz' | \
  docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose start backend worker wabot
```

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

### Devin/agent skills (`.devin/skills/`)

Domain playbooks checked into the repo — agent sessions auto-load the matching
one: `wabot` (WhatsApp bot architecture/commands/quirks), `poller`
(worker/probe-watch/Ruijie budget), `status-engine` (status & alert rules),
`route-guard` (new endpoint/command recipe), `realtime` (Redis→WS→cache chain),
`frontend` (query/auth/preview conventions), `mikrotik` (RouterOS client rules),
`prisma` (schema/migration/secret rules), `verify` (the CI gate), `deploy`
(production deploy via systemd-run), `ops` (production diagnosis runbook).

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
| `TRUST_PROXY` | trust `X-Forwarded-For` (`true`, hop count, or proxy IPs) — only when behind a proxy and the backend port isn't public |
| `APP_BIND` | optional bind IP for the published app ports (e.g. `127.0.0.1:` behind a proxy) — `deploy.sh --app-bind` |
| `POLL_INTERVAL_DEFAULT_SEC` | default worker poll interval |
| `WORKER_SHARD_COUNT` / `WORKER_SHARD_INDEX` | horizontal worker scaling |
| `WA_ENABLED` / `WA_DRIVER` | WhatsApp bot on/off; `baileys` (real) or `mock` (log-only dev) |
| `WABOT_HEALTH_PORT` | wabot `/health` port inside the container (default 4200) |
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

## Interface-watch ("uplink") devices

A device can monitor a **RouterOS interface's `running` flag** instead of a
Netwatch ping — e.g. the port/tunnel that is the outbound path to another site
("jalur ke 001"). Open the device editor → **Pantau interface uplink** → pick
the interface from the live `/interface/print` list (or type the name manually
when the router is unreachable).

- The worker derives status every router poll: `running` → up, off/disabled →
  down, interface missing → `unknown` (config drift, never a blind outage).
- **Work-hours alerts:** notifications fire only inside an alert window —
  global default in **Settings → Monitoring & Alerts** (start/end + weekdays,
  overnight windows like 18:00→06:00 supported), or a per-device override in
  the same editor section. The map status still tracks 24/7.
- **Catch-up:** an uplink still down when the window opens gets one alert then
  (deduped per window instance) — no silent overnight outages.
- Everything else is the normal device path: `isCritical` gate, maintenance /
  silence, Telegram + WhatsApp routing, cooldown, status history
  (`source: "interface"`).

---

## WhatsApp bot (multi-purpose)

A dedicated `wabot` service (Baileys) turns the NOC into a two-way ops channel:
**network alerts, hotspot self-service, complaint tickets, staff commands, and
broadcasts** — all over WhatsApp. Design doc: `docs/whatsapp-bot-plan.md`.

**Console:** everything WhatsApp lives on one page — **Admin → WhatsApp**
(gated `whatsapp:manage`, super_admin): connection/session, bot settings,
per-site recipients, test & broadcast.

**Pairing (once):** Admin → WhatsApp → *Koneksi & Sesi* → scan the QR with
WhatsApp → *Perangkat Tertaut*. Session keys are stored **encrypted** in
`wa_auth_key`, so container rebuilds never re-pair. To switch numbers:
**Sesi baru / ganti nomor** unlinks the device, wipes the keys and issues a
fresh QR; **Reconnect** only restarts the socket (keeps the session).
`WA_DRIVER=mock` exercises the whole pipeline (outbox → send log) with no
real number.

**Per-site config:** Admin → WhatsApp → *Penerima Alert & Tiket*: set the
site's mode `server`, then add recipients — each row is a **number**
(`kind=number`) or a **group** (`kind=group`) with its own `alerts` (device
down/recovery) and `tickets` (complaint forwards) toggles; `role=manager`
receives escalations. Groups are **picked from a dropdown**, not typed — once
connected, the bot publishes its participating-group list (`noc:wa:groups`,
refreshed on connect/group events or via ⟳ → `POST /whatsapp/groups/refresh`)
so only groups it can actually send to are selectable.

**Phone linking:** a user (member or staff) opens their account page → *Buat
kode link* → texts `LINK <kode>` to the bot. Only verified numbers get
commands; unknown numbers can only file a complaint.

**Commands** (private chat, Bahasa Indonesia):

| Who | Command | Does |
| --- | --- | --- |
| anyone | `MENU`, `PING`, `INFO` | help / liveness / portal + contact |
| anyone | `KOMPLAIN <pesan>` (aliases `LAPOR`, `KELUHAN`, `GANGGUAN`) | file a ticket (anonymous → name → **department** → site → message wizard) |
| anyone | `LINK <kode>` · `DAFTAR` | bind number to a portal account · request a new account |
| anyone | `TIKET` | tickets filed from this number |
| member | `STATUS` (aliases `AKUN`, `KUOTA`) | own quota, profile, active sessions |
| member | `LOGOUT` | kick own hotspot sessions |
| member | `TIKET` | own complaint tickets + status |
| staff | `SITES`, `DOWN [site]`, `CEK <device>` | monitoring scope (site-filtered) |
| staff | `ACK`/`UNACK <device>` | claim / release an incident |
| staff | `MAINT`/`AKTIF <device>` | maintenance override on/off (mirrors web PATCH) |
| staff | `SILENT <device> [min]` / `BUNYI` | suppress alerts N min (default 60) / restore |
| staff | `PING <ip|device>`, `LAPORAN [site]`, `TIKET [kode]` | diagnostics + digest + ticket queue/detail |
| super_admin | `BOTSTATUS` | WA session + outbox/queue health from chat |
| super_admin | `WADEAD` · `KIRIMULANG <id>` | list dead-letter messages · requeue one by id prefix |
| technician | `PROSES <kode>` / `SELESAI <kode>` | work a ticket; reporter gets notified |
| WaRecipient (no account) | `TIKET`/`DOWN`/`CEK`/`SITES`/`LAPORAN` | read-only ops scoped to its recipient sites |
| group chat | `PROSES`/`SELESAI` (+ staff read cmds) | ticket replies work in recipient groups; member/public flows stay private |
| any reply | `SELESAI` (quoted reply) | reply a ticket card without retyping the code; `SELESAI <kode> <catatan>` stores a resolution note |
| staff (private) | `MAINT SITE <nama>` / `SILENT SITE <nama> [menit]` | bulk maintenance/silence for a whole site; ambiguous lookups offer a numbered pick (reply `1-9`) |

Tickets land on the web at **/tickets** (filterable, `tickets:view`/`manage`
permissions); members file and track their own at **/akun** (`/me/tickets`,
same shared pipeline — web complaints work without a linked phone). Open tickets older than `waTicketEscalateMin` minutes are
escalated once to `manager` recipients by the worker. Broadcasts:
**Admin → WhatsApp → Uji & Broadcast** sends an announcement to a
site's recipients + verified members.

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

---

## License

**Proprietary — all rights reserved.** No license is granted to use, copy,
modify, or distribute this codebase outside the deploying organization.
