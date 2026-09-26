---
name: poller
description: Expert worker/poller (apps/worker) — scheduler sharding, circuit breaker, reconcile-once, probe watch modes, tugas singleton vs sharded, budget Ruijie, dan kebijakan error worker
argument-hint: "[topik: scheduler|watch|ruijie|escalator|retention]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: Worker & Poller (apps/worker)

Gunakan setiap kali mengubah `apps/worker` atau logika polling/probe/Ruijie/eskalasi/retensi. Jawab Bahasa Indonesia. Aturan status device sendiri ada di skill `/status-engine` — skill ini fokus ke *mesin penjadwalnya*.

## Peta file

| File | Tugas | Mode jalan |
|---|---|---|
| `scheduler.ts` | Poll tiap router pada intervalnya; circuit breaker per-router; reconcile device→`unknown` saat router offline | **sharded** — `WORKER_SHARD_COUNT`/`_INDEX`, hash id router |
| `poller.ts` | Satu pass poll per router: resource → netwatch reconcile → interface watch → config-drift → TCP probe → NAT probe | dipanggil scheduler |
| `ruijie-poller.ts` | Fleet poll Ruijie Cloud per akun (1 call = seluruh fleet) | **singleton** — primary shard saja |
| `ruijie-port-poller.ts` | Per-port truth (degradasi/flap link) dari Ruijie | singleton |
| `wifi-enricher.ts` | Korelasi device⇄AP (getClients per building-group — MAHAL) | singleton, 15 mnt |
| `ticket-escalator.ts` | Tiket `open` > `waTicketEscalateMin` → ping manager/grup + pelapor | singleton |
| `retention.ts` | Sapu `StatusEvent`/`AuditLog`/`RefreshToken` lama per `*RetentionDays` | singleton, tiap jam |
| `health.ts` / `index.ts` | `/health` server + bootstrap + handler proses | — |

## Aturan keras

- **Perintah polling melewati status-engine** — `pollRouter` memanggil `applyDeviceStatusesByHost` / `applyDeviceStatus`; JANGAN update `Device.status` langsung.
- **Probe-owned device dikecualikan** dari reconcile Netwatch (`applyDeviceStatusesByHost` skip device dengan `watchInterface`/`watchPort`/`watchNatDstPort` non-null) — verdict probe adalah miliknya sendiri. Netwatch entry di IP yang sama tidak boleh menimpanya.
- **Circuit breaker**: backoff eksponensial `5s·2^min(failures,6)` maks `maxBackoffMs`. Gagal ≥ `reconcileAfterFailures` (2) → `reconcileDevicesUnknown` SEKALI per outage (`st.reconciled`), retry tiap gagal sampai selesai, reset saat poll sukses. Status `unknown` bukan `down` — jangan mengarang verdict.
- **Aux watch wajib `.catch`-wrap sendiri** (`checkConfigDrift`, interface/TCP/NAT probe) — bug probe TIDAK boleh menggagalkan poll atau breaker akan menandai router sehat sebagai offline.
- **Poll deadline** `pollDeadlineMs` 25s + `hooks.onClient` → `abort()` force-close socket wedged; watchdog `stuckMs` membebaskan tick macet.
- **Log error**: `err.message || err.code || err.name` — node-routeros sering melempar `Error` dengan message KOSONG (`"err":""` di log tidak bisa di-debug).
- **Proses tidak boleh crash-loop**: `unhandledRejection`/`uncaughtException` di `index.ts` = log-dan-lanjut. node-routeros bisa emit error socket async di luar await.

## Ruijie budget (5.000 call/hari bersama)

- Fleet poll = prioritas tertinggi + termurah (1 call/akun) → `MIN_BUDGET` 2.
- `wifi-enricher` adalah konsumen terbesar (getClients per building-group) → interval 15 mnt + Redis cache TTL 45 mnt supaya satu-dua tick lompat tidak mengosongkan peta. `RUIJIE_RESERVE_ENRICHER` menyisakan kuota.
- Port poller memakai reserve sendiri — jangan menambah call Ruijie tanpa menghitung budget (cek pola `budget` di masing-masing file).
- Semua tugas Ruijie singleton — double-poll = double spend kuota.

## Probe watch (ringkas — detail: `docs/watch-modes.md`)

| Field | Sumber truth | StatusSource | Catatan |
|---|---|---|---|
| `watchInterface` | flag `running` interface RouterOS | `interface` | absent → `unknown`, never blind verdict |
| `watchPort` | TCP connect NOC→`ipAddress:port` (4s) | `tcp` | refused/timeout → `down`; no IP → `unknown` |
| `watchNatDstPort` | counter `bytes` rule dst-nat | `traffic` | rule hilang → `unknown`; **disabled → `down`**; flat > `watchNatStaleMin` (def 5m) → `down`; counter menyusut → re-baseline `noc:device:<id>:natwatch` |

- Alert untuk probe digate **work-hours window**: `uplinkAlert{Start,End}Min/Days` global, override per-device `watchAlertWindow` (JSON `AlertWindow`, mendukung window lewat tengah malam). Status tetap update 24/7 — hanya notifikasi yang ditekan.
- `uplinkWindowCatchUp` kirim satu "masih down saat window dibuka" — dedup flag Redis per-instance window. Container `TZ=Asia/Jakarta` — evaluasi wall-clock.
- `RouterMikrotik.watchConfig` = drift watch firewall (snapshot nat/filter/mangle per-poll → diff → audit `router.config-change` + WS toast + TG/WA di server-relay site). Berjalan di dalam poll, `.catch`-wrapped.

## Resep: menambah background job

1. File baru `apps/worker/src/<job>.ts` — pola `class X { start(); stop(); stats }` dengan `setInterval` + guard `running` (lihat `TicketEscalator`/`RetentionSweeper`).
2. Tentukan sharded vs singleton: menyentuh router per-row → sharded via `inShard(router.id)` (hash-31 id % `WORKER_SHARD_COUNT`); tugas global (quota, agregat, tiket) → **primary shard only** (`WORKER_SHARD_INDEX === 0`, lihat pola `primary ? new X : null` di `index.ts`).
3. Timer `.unref()` bila perlu; `stop()` clear timer.
4. Sweep DB besar → `deleteInBatches` (~500/statement + pause), jangan `deleteMany` raksasa (table lock).
5. Error policy: catch di dalam loop per-item; warn-log dengan `message || code || name`; jangan biarkan satu row jahat mematikan sweep.
6. Daftarkan di `index.ts` (start/stop + stats di `/health`).
7. Mutasi state device → status-engine / `updateRouterStatus`, bukan tulis langsung.
8. Validasi: `npm run typecheck -w @noc/worker`.

## Operasional

- Log pola: `'router poll failed (circuit breaker engaged)'` (failures/backoffMs/err) → `'reconciled devices to unknown (router offline)'` → `'polled router'` saat pulih.
- `/health` worker expose stats scheduler/poller — cek `lastTick`, `routerCount` bila "status tidak berubah".
- Dev box ini TANPA Docker — jalur Postgres/Redis/RouterOS hanya bisa diverifikasi di Docker host; di sini gate-nya typecheck.
