---
name: frontend
description: Konvensi frontend (apps/frontend) — TanStack Query + qk factory, optimistic updates + rollback, WS cache patching, same-origin proxy, auth/refresh, gating can(), copy Bahasa Indonesia, dan harness preview mock
argument-hint: "[topik: query|ws|auth|preview]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: Frontend (apps/frontend)

Next.js App Router + Tailwind + TanStack Query + Leaflet. Copy UI **Bahasa Indonesia** — samakan gaya sekitar. Jawab user Bahasa Indonesia.

## Lapisan data — jangan bikin pola baru

- **`lib/api.ts`** — satu client `api`; token dari `localStorage`; **auto-refresh access token pada 401** lalu redirect `/login`. Jangan fetch manual pakai `fetch()` di komponen.
- **`lib/queries.ts`** — factory `qk` untuk semua query key + hooks TanStack Query. Menambah query → tambah di factory + hook di file ini, bukan `useQuery` inline dengan key ad-hoc.
- **Optimistic updates + rollback** — drag-to-move marker & reorder memakai pola onMutate cache-set + rollback onError. Ikuti pola yang sama untuk mutasi cepat lain; jangan refetch kasar setelah mutasi lokal.
- **`applyWsEvent`** (`queries.ts`) — event WS dipatch **per-device** ke cache query, sehingga satu marker berubah tanpa refetch. Event baru harus punya cabang di sini.

## Realtime

`lib/ws.ts` `useSiteSocket(siteId)` — subscribe room site; JWT dikirim sebagai `Sec-WebSocket-Protocol` offer `['bearer', token]` (BUKAN `?token=` — itu bocor ke log). Detail rantai publish→hub→cache ada di skill `/realtime`.

## Auth & gating

- `lib/auth.tsx` — React context auth (me/roles). `can()` dari `@noc/shared` hanya untuk **menyembunyikan UI** — server selalu menegakkan ulang (`route-guard`). Jangan andalkan `can()` sebagai security.
- Login berada di luar grup `(app)` — halaman dalam `(app)` dibungkus `Shell` (nav digate `can()`).

## Same-origin proxy — PENTING

Di browser base API = `''` (kosong). `next.config.mjs` me-rewrite `/api/*` dan `/uploads/*` ke `BACKEND_ORIGIN` di jaringan internal → browser hanya bicara satu origin (tanpa CORS/domain API terpisah). Jangan menulis URL absolut backend di komponen; selalu lewat `api`/path relatif.

## Idiom UI yang sudah ada (pakai ulang, jangan bikin pola baru)

- **`components/ui.tsx`** = satu-satunya sumber primitives: `Page/PageHeader/PageBody`, `Toolbar`, `FilterBar`, `DataTable` (kolom `hideBelow` + stack `r-table` di HP), `MetricCard`, `IconTile`, `Badge`, `Tabs`, `StatusPill`, `EmptyState/ErrorState`, `Skeleton` (`noc-skeleton` shimmer — gating `prefers-reduced-motion` di CSS).
- **`CommandPalette`** (Ctrl+K / `/`) di Shell — cari halaman (perm-filtered), site, perangkat (`/devices?search=` debounce 250ms, `?device=<id>` deep-link ke inspect panel site page). Tambah halaman baru → daftar di `PAGES`.
- **`LiveBadge`** di footer sidebar — dot live/terputus dari status `useSites()` (zero request ekstra); jangan bikin probe koneksi baru.
- **PWA**: `app/manifest.ts` + `public/icon.svg` + `app/icon.svg`; `viewport.viewportFit='cover'` + `noc-safe-top` untuk notch iOS.
- Transisi halaman: wrapper `key={pathname} .noc-fade` (180ms, reduced-motion aware). Focus keyboard: `:focus-visible` accent ring global (input `noc-focus` punya ring sendiri).
- Touch: `noc-tap` = 44px di bawah lg/coarse-pointer; jangan kurangi.

## Gotcha build & preview

- `npm run build` = `next build` — SATU-SATUNYA workspace yang dibuild. Node service lain jalan lewat tsx (tanpa dist).
- **`next dev` menimpa `.next` produksi** (hapus `BUILD_ID`) — setelah `next dev`, WAJIB `next build` ulang sebelum `next start`.
- **Mock harness** `.preview/mock.mjs` — Fastify mock seluruh `/api/v1` di :4000 (seed: site geo+floorplan, router, device mixed-status, hotspot, app user; login menerima email apa pun — `operator@`/`user@` memetakan role untuk uji RBAC). Preview lewat `next start` (config `.claude/launch.json`).
- **Screenshot timeout ~30s di env ini** walau DOM sehat — verifikasi halaman via `preview_eval`/`preview_inspect` (computed style/DOM), bukan screenshot.
- Tanpa Docker di box ini: backend/Postgres/Redis asli tidak jalan — uji UI cukup mock harness.

## Resep: halaman/fitur baru

1. Route di `(app)/<fitur>/page.tsx` — dibungkus `Shell` otomatis.
2. Tambah query: `qk.<fitur>.*` di `queries.ts` + hook (`useXQuery`); mutasi via `useMutation` + invalidasi `qk` terkait (atau optimistic patch bila ada polanya).
3. Gate UI pakai `can(role, '<perm>')` dari shared rbac — mirror permission yang dipakai route backend.
4. Copy: Bahasa Indonesia, singkat, gaya sama dengan komponen tetangga (lihat halaman sejenis dulu).
5. Peta: Leaflet geo (`geoLat/Lng`) atau floorplan (`mapX/Y`, CRS.Simple) — komponen peta sudah ada; jangan import lib peta lain.
6. Event WS baru → tambah handler di `applyWsEvent` + kontrak `WsServerEvent` di shared (lihat `/realtime`).
7. Validasi: `npm run typecheck -w @noc/frontend` + `npm run build`.
