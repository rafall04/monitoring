# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**MikroTik NOC** — an all-in-one Network Operations Center for fleets of MikroTik routers across many sites. Device status comes from **RouterOS Netwatch** (the server does *no* ICMP scanning), is visualized on a per-site Leaflet map (geographic *or* uploaded factory floorplan), and hotspot users/profiles/vouchers/sessions are managed from the web. Access is gated by 3 roles with per-site scoping.

The monitoring spine is built deeply; hotspot/reports/admin screens are intentionally lighter. RouterOS **v6 (binary API) only** — v7 REST is a deliberate stub (see below). Much of the user-facing copy is in **Indonesian**; match the surrounding language when editing UI strings.

## Commands

```bash
npm install                      # root install — npm workspaces hoist everything
npm run prisma:generate          # REQUIRED before any typecheck/build (see gotcha)
npm run typecheck                # tsc --noEmit across all 5 workspaces — the main gate
npm run build                    # NOTE: builds the frontend only (next build)
npm run dev                      # backend :4000 + worker :4100 + frontend :3000 (concurrently)
npm run dev:backend              # single process; also dev:worker / dev:frontend
npm run seed                     # default accounts; SEED_DEMO=true also seeds demo data
```

- **Single-workspace typecheck:** `npm run typecheck -w @noc/backend` (or `@noc/worker`, `@noc/frontend`, `@noc/shared`, `@noc/server`).
- **Prisma:** `prisma:migrate` (dev), `prisma:deploy` (prod/CI), `prisma:studio`. The schema + seed live in `packages/server/prisma/`.
- **There is no test runner** — automated tests do not exist yet. The validation gate is **typecheck + frontend build**, exactly what CI runs (`.github/workflows/ci.yml`: `npm ci` → `db:generate` → `typecheck` → `build`). Don't go looking for a `test` script.
- **Seeded logins** (`npm run seed`): `admin@noc.local` / `admin123` (super_admin), `operator@noc.local` / `operator123` (operator), `demo@noc.local` / `demo123` (viewer). Passwords are set **only on first create**, so a re-seed never resets one an admin already changed.

**Run model:** the Node services (backend, worker) execute TypeScript directly via **`tsx`** — there is no compile step and no `dist/`. Only the frontend has a build (`next build`). `@noc/shared` and `@noc/server` are consumed as raw `.ts` source through workspace `main: ./src/index.ts`.

### Gotchas
- **Prisma client must be generated before typechecking.** `@noc/server` imports `@prisma/client` types; a fresh checkout fails `tsc` until `npm run prisma:generate` runs. CI does this explicitly.
- **`npm run build` ≠ build everything** — it only runs `next build`. The Node services are never bundled.

## Local validation on this machine (no Docker / Postgres / Redis)

This dev box has only Node 20 + git, so the **full stack cannot run here**. DB / Redis / live-MikroTik paths are untested locally — verify those on a Docker host. What *is* runnable:

- **Typecheck all workspaces** + **`next build`** (the real correctness gate here).
- **UI preview harness:** `node .preview/mock.mjs` starts a Fastify mock of the entire `/api/v1` surface on **port 4000** (seed data: sites with floorplan + geo, routers, mixed-status devices, hotspot users/profiles/sessions, app users; login accepts any email — `operator@`/`user@` map to those roles for RBAC gating tests). Preview the frontend with **`next start`** (config in `.claude/launch.json`).
  - **Gotcha:** `next dev` overwrites the production `.next` (deletes `BUILD_ID`), so always re-run `next build` before `next start`.
  - **Screenshots time out (~30s) in this env** even on a healthy DOM — verify pages via `preview_eval` / `preview_inspect` (computed styles / DOM), not screenshots.

## Architecture

### Three processes, one shared core
A monorepo of 5 workspaces. The split exists because Next.js can't host long-lived router TCP connections, background polling, or a WebSocket server:

- **`packages/shared`** — isomorphic, *zero runtime deps but zod*. The **single source of truth** imported by every other workspace: domain `types`, `zod` `schemas` (request validation; inferred types reused by frontend forms), the `rbac` matrix, WebSocket event contracts + Redis channel/key names (`events`), and Netwatch/Telegram message `templates`.
- **`packages/server`** — Node-only shared library (not a process): Prisma client (`db`), validated `env`, `logger` (pino), Redis (`redis`), AES-256-GCM `crypto`, DTO `mappers`, the global `settings` singleton, Telegram `notify`, the **`status-engine`**, and the `mikrotik` client. Both `apps/backend` and `apps/worker` build on this.
- **`apps/backend`** — Fastify REST (`/api/v1/*`) + the WebSocket hub + the Netwatch webhook receiver.
- **`apps/worker`** — the Netwatch poller/reconciler + retention sweeper + a health server. No HTTP API surface (just `/health`).
- **`apps/frontend`** — Next.js App Router + Tailwind + TanStack Query + Leaflet.

### The status engine is the convergence point
`packages/server/src/status-engine.ts` is the **only** place a device status change is applied, so the **webhook path** (realtime, `apps/backend/src/routes/webhook.ts`) and the **poller path** (heartbeat/reconciliation, `apps/worker/src/poller.ts`) behave identically. On a *changed* status it transactionally updates the `Device` row + writes a `StatusEvent`, refreshes the Redis status cache, publishes `device.status` + a recomputed `site.summary`, and fires a Telegram alert for critical devices. An *unchanged* status only refreshes the Redis heartbeat. Recovery (`up`) clears incident ack metadata. When touching status logic, edit it here — not in the two callers.

### Device status vs. manual override (two separate fields)
`Device.status` is the **raw** Netwatch truth — `up | down | unknown` (`DeviceStatus`); the status-engine only ever writes these, tagging each change with a `StatusSource` (`webhook | polling | manual`). `maintenance` is **not** a status — it's a separate `Device.manualOverride` field that **suppresses alarms and wins the displayed status** (a flapping host under maintenance never pages). Markers and alerting must fold the two together with `effectiveStatus(status, override)` (`@noc/shared` `types.ts`), which returns the `DisplayStatus` actually rendered (`up | down | unknown | maintenance | warning`) — never branch on `status` alone.

### Realtime flow (worker/webhook → browser)
status-engine **publishes** to Redis channel `noc:site:<id>:events` → the backend **WS hub** (`apps/backend/src/ws/hub.ts`) `psubscribe`s `noc:site:*:events` and fans each message out to sockets that joined that site's room → the frontend (`lib/ws.ts` `useSiteSocket`) patches the **TanStack Query cache per-device** (`lib/queries.ts` `applyWsEvent`) so one marker updates without a refetch. Channel/key names come from `@noc/shared` `events.ts` — never hardcode them. WS auth is the access JWT passed as `?token=`; subscribe is re-checked against `canAccessSite`.

### Data model & hierarchy
`Company → Site → RouterMikrotik → Device`, where a Device's `ipAddress` is the host a Netwatch entry watches (status is resolved by `routerId + ipAddress`). On top sits an org overlay for the factory use-case: `Site.region` (kabupaten) groups the overview; **`Area`** (`kind: lines | room`) and **`Line`** give devices an ordered swimlane position (`Device.areaId/lineId/orderIndex`) independent of their map coordinates. A device has *both* map coords (`geoLat/Lng` or floorplan `mapX/Y`) and a structural slot. A single global **`Setting`** row (`id="global"`) holds white-label branding + operational defaults (poll interval, retention days, Netwatch timing, Telegram templates). Schema: `packages/server/prisma/schema.prisma`.

### Auth & RBAC (enforced server-side, mirrored client-side)
`packages/shared/src/rbac.ts` is the **single permission matrix** used by *both* sides. The frontend uses `can()` only to hide UI; the backend always enforces. Standard route guard composition:

```ts
{ onRequest: [authenticate], preHandler: [requirePermission('site:manage')] }
```

`authenticate` (`plugins/auth.ts`) verifies the JWT and reloads a **fresh** user snapshot every request (so role/scope/deactivation take effect immediately — no stale tokens). Permission is role-level; **site-level access is a separate, explicit check inside the handler** once the target's `siteId` is known: `assertSiteAccess(req.appUser, siteId)` for single resources, `siteScopeWhere(req.appUser)` for list queries (`{}` for super_admin). Forgetting the site check is the easy bug — permission alone does not scope. Auth = JWT access (15m) + rotating opaque refresh tokens stored hashed (sha256); passwords use **bcryptjs** (pure-JS, chosen to avoid a native toolchain — swap to argon2 where one exists).

### Secrets never reach the browser
Router passwords and Telegram bot tokens are encrypted at rest with AES-256-GCM (`crypto.ts`, key from `CREDENTIALS_ENC_KEY`, format `v1:<iv>:<tag>:<ct>`). DTO **mappers** (`packages/server/src/mappers.ts`) are responsible for stripping them — the API exposes booleans like `hasTelegramToken`, never the ciphertext. When adding a field that holds a secret, encrypt on write and make sure the mapper omits it.

### MikroTik client abstraction
`createMikrotikClient(cfg)` returns a `MikrotikClient` interface (`mikrotik/types.ts`). `RouterOsV6Client` (binary API via `node-routeros`) is the only implementation; **v7 deliberately `throw`s** — the v7 REST adapter is a planned drop-in behind the same interface, not a bug. `clientForRouter(row)` decrypts the stored password and builds a client. The Netwatch script generator (`mikrotik/netwatch.ts`) is kept pure (no DB import) and uses **URL query params, not a JSON body**, so generated RouterOS scripts have no inner quotes to escape — identical text works for copy-paste and binary-API install. Human-facing install/integration docs + ready-to-paste scripts live in `docs/netwatch-examples.md`.

### Worker scheduling
`scheduler.ts` polls each router on its own interval, **shards** the fleet across worker instances by id-hash (`WORKER_SHARD_COUNT`/`_INDEX`) for horizontal scaling, and applies a **per-router circuit breaker** (exponential backoff to 5 min) so one dead router never blocks the pool. The process installs `unhandledRejection`/`uncaughtException` handlers that *log and continue* — `node-routeros` can emit stray async socket errors (e.g. `SOCKTMOUT`) outside the awaited path, and a monitoring poller must never crash-loop on an unreachable router. Once a router crosses a small consecutive-failure threshold (confirmed offline, not a one-off timeout), the scheduler **reconciles its devices to `unknown`** once, via the status-engine — leaving them green would make the dashboard lie during exactly the outage operators watch for; recovery polls restore real `up`/`down` from Netwatch.

### Frontend
Next.js App Router. The `(app)` route group is wrapped by `Shell` (nav gated via `can()`); `/login` is outside it. Data layer is **TanStack Query** with `qk` query-key factory (`lib/queries.ts`); mutations use **optimistic updates** (drag-to-move markers, reorder) with rollback, plus the WS cache-patching above. Auth state is a React context (`lib/auth.tsx`); tokens live in `localStorage` and the `api` client (`lib/api.ts`) auto-refreshes on 401 then redirects to `/login`.

**Same-origin proxy design (important):** in the browser the API base is the **empty string** — the Next.js server *rewrites* `/api/*` and `/uploads/*` to the backend over the internal network (`next.config.mjs`, `BACKEND_ORIGIN`). So the browser only ever talks to one origin → **no CORS, no separate public `api.` domain needed**. **But Next rewrites can't proxy WebSocket upgrades**, so `lib/ws.ts` reaches the backend directly (`ws://<host>:<backendPort>/ws` for IP/localhost, or same-origin `wss://<domain>/ws` behind a tunnel that routes `/ws`). If `/ws` isn't routed, live updates degrade gracefully — the rest of the app still works over HTTP.

## Deployment (production = Docker on Ubuntu)
`deploy.sh` is a one-command interactive installer (installs Docker if missing, generates `.env` with fresh secrets, builds, `docker compose up -d`, runs migrations + seed). **Containers always listen on fixed ports 4000 (backend) / 3000 (frontend); only the host port mapping is configurable** (`BACKEND_PORT`/`FRONTEND_PORT`, defaults 3500/3600). Frontend `NEXT_PUBLIC_*` are **baked at build time**, so changing host/ports rebuilds the frontend image. Domain/TLS is opt-in (bundled Caddy with Let's Encrypt, or `--cloudflare` for an external tunnel with no local proxy). Prisma's engine needs OpenSSL, which `node:20-alpine` lacks — the backend/worker Dockerfiles `apk add openssl` (omitting it crash-loops `prisma migrate deploy`). README has the full deploy matrix.

## When adding an API route
1. Define the zod schema + inferred type in `packages/shared/src/schemas.ts`.
2. Register the route under the right prefix in `apps/backend/src/routes/index.ts`.
3. Guard with `onRequest: [authenticate]` + `preHandler: [requirePermission(...)]`, and **add the site check** (`assertSiteAccess` / `siteScopeWhere`) inside the handler.
4. Return DTOs via `mappers` (never raw Prisma rows holding secrets).
5. `writeAudit(req, {...})` for sensitive mutations (`lib/audit.ts`).
6. If a status changes, go through the **status-engine**, not Prisma directly, so realtime + events + Telegram stay consistent.
