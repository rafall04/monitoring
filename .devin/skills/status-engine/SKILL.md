---
name: status-engine
description: Aturan saat mengubah logika status device/alerting — satu titik konvergensi status-engine, effectiveStatus vs manualOverride, gating alert, probe watch
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: Status Engine & Alerting

Gunakan setiap kali menyentuh: status device, Netwatch webhook/poller, notifikasi Telegram/WA, ack/silence/maintenance, atau probe watch (interface/TCP/NAT).

## Hukum #1: satu titik konvergensi

`packages/server/src/status-engine.ts` adalah **satu-satunya** tempat perubahan status device diterapkan. Dua caller — webhook (`apps/backend/src/routes/webhook.ts`) dan poller (`apps/worker/src/poller.ts`) — **harus** berperilaku identik.

- Jangan pernah menulis `prisma.device.update({ status })` atau logika transisi status di luar status-engine. Logika baru masuk ke engine, bukan ke caller.
- Yang dilakukan engine pada status BERUBAH: update `Device` + tulis `StatusEvent` (transaksional) → refresh cache Redis → publish `device.status` + `site.summary` recompute → fire alert. Status SAMA hanya refresh heartbeat Redis. Recovery (`up`) membersihkan metadata ack insiden.
- `StatusSource`: `webhook | polling | manual | interface | tcp | traffic` — tag setiap perubahan dengan sumbernya.

## Hukum #2: status vs override adalah dua field berbeda

- `Device.status` = kebenaran mentah (`up|down|unknown`). **`maintenance` BUKAN status** — itu `Device.manualOverride` terpisah yang menekan alarm dan memenangkan status tampilan.
- Jangan pernah `if (device.status === 'maintenance')` atau branch pada `status` saja untuk tampilan/alerting. Selalu lipat keduanya lewat `effectiveStatus(status, override)` → `DisplayStatus` (`up|down|unknown|maintenance|warning`) dari `@noc/shared` `types.ts`.
- Gotcha SQL yang sudah terjadi: `manualOverride != 'maintenance'` **mengeluarkan baris NULL** di SQL — pakai `OR: [{ manualOverride: null }, { manualOverride: { not: 'maintenance' } }]`.

## Gating alert (notify.ts — pola identik Telegram & WA)

Alert hanya keluar bila SEMUA terpenuhi:
1. `device.isCritical`
2. `manualOverride !== 'maintenance'`
3. `silencedUntil` tidak di masa depan
4. Transisi `down` atau recovery `up` saja
5. Per-channel switch site: `telegramMode='server'` / `whatsappMode='server'`
6. Cooldown anti-flap per channel: `noc:tgcooldown:` / `noc:wacooldown:` `<device>:<status>` EX 90 NX
7. **Jam kerja** untuk probe-watch: `Setting.uplinkAlert{Start,End}Min/Days` global atau `Device.watchAlertWindow` per-device (`AlertWindow`, mendukung window lintas tengah malam). Status tetap update 24/7 — hanya notifikasi yang ditekan; `uplinkWindowCatchUp` kirim satu "masih down saat jam buka" (dedup flag Redis per-window). Kontainer `TZ=Asia/Jakarta` — window evaluasi wall-clock.

## Alert level SITE (router reachability)

- `updateRouterStatus` juga men-fire `notifyRouterStatus` pada transisi nyata (prev-read dedup): `→offline` = `🔴 SITE OFFLINE` (N perangkat → UNKNOWN), `offline→online` = `🟢 SITE ONLINE`. Gate: `telegramMode`/`whatsappMode='server'` + `WaRecipient{alerts:true}`; cooldown per-channel `noc:tgcooldown:router:`/`noc:wacooldown:router:<id>:<st>` EX 300 NX.
- Caller-nya SEMUA jalur status router: poller/shard, reconcile circuit-breaker, DAN tombol test-connection backend — jangan pindahkan notif ke caller (transisi tombol-test juga outage nyata).
- Router status jangan digate jam-kerja/isCritical — site gelap itu page 24/7.

## Probe-watch devices (tiga mode saling eksklusif — set satu membersihkan yang lain)

- `watchInterface` — status ikuti flag `running` interface RouterOS (`disabled`/not-running → `down`, absent → `unknown`; `source='interface'`).
- `watchPort` — server connect `ipAddress:watchPort` timeout 4s (`'tcp'`).
- `watchNatDstPort` + `watchNatStaleMin` — kebenaran = counter `bytes` rule dstnat: missing → `unknown`, **disabled → `down`**, counter flat lewat window → `down`, tumbuh → `up`; read pertama `unknown` jujur, counter menyusut → re-baseline di Redis `noc:device:<id>:natwatch` (`'traffic'`).
- `applyDeviceStatusesByHost` **mengecualikan** device yang punya probe-watch — Netwatch pada IP yang sama tidak boleh menimpa verdict probe.
- Di dalam `pollRouter`: ketiga watch di-`.catch`-wrap individual — bug probe log warning, tidak boleh gagalkan poll (circuit breaker akan salah tandai router sehat jadi offline).
- Sibling: `RouterMikrotik.watchConfig` (config-drift watch) → `router.config-change` audit + `router.config` WS + notif di site server-relay.

## Checklist perubahan

1. Edit logika di `status-engine.ts` (atau `notify.ts`/`uplink.ts` untuk alerting), BUKAN di dua caller.
2. Field/status baru → update tipe di `@noc/shared` (`types.ts`), schema zod bila perlu, `effectiveStatus`/`STATUS_LABELS`/`STATUS_COLORS` bila DisplayStatus berubah, lalu `prisma:generate` bila schema Prisma berubah.
3. Perubahan kontrak Redis/WS → update `events.ts` (channel/key names — tidak boleh hardcode string `noc:...` di tempat lain).
4. Verifikasi kedua jalur tetap simetris: webhook dan poller.
5. Gate: `npm run prisma:generate` → `npm run typecheck` (lihat skill `/verify`).

## Referensi

- Ops doc lengkap watch modes: `docs/watch-modes.md`.
- Realtime fan-out: `noc:site:<id>:events` → WS hub `psubscribe` → `applyWsEvent` patch cache TanStack per-device.
