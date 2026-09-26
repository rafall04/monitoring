---
name: mikrotik
description: Konvensi klien MikroTik (packages/server/src/mikrotik) — RouterOS v6 binary API saja (v7 stub sengaja), clientForRouter + decrypt, generator netwatch murni tanpa DB, pola pakai client (close di finally), dan batasan probe/watch
argument-hint: "[topik: client|netwatch|hotspot|firewall]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: Klien MikroTik (packages/server/src/mikrotik)

## Hukum dasar

- **RouterOS v6 binary API SAJA** — `RouterOsV6Client` (`v6.ts`, `node-routeros`). `createMikrotikClient({version:'v7'})` **sengaja `throw`** — adapter REST v7 adalah drop-in terencana di belakang interface `MikrotikClient` yang sama, bukan bug. Jangan "memperbaiki" throw-nya; bila v7 dibutuhkan, implementasi adapter penuh di belakang interface.
- **Selalu `clientForRouter(row)`** — decrypt `passwordEncrypted` + bentuk config. Jangan decrypt manual atau pegang `password` polos di luar fungsi ini; jangan log kredensial.
- **`MikrotikClient`** (`types.ts`) = satu-satunya permukaan: `getResource`, `listNetwatch`, `pingHost`, hotspot user/profile/session, firewall/address-list/nat/mangle, interface list, dhcp lease, dst-nat counter, dll. Method baru kebutuhan fitur → tambah ke interface + implement di `v6.ts`.
- **Selalu `close()` di `finally`** — socket TCP hidup; pola resmi (lihat `staffPing`): `const c = clientForRouter(r); try { ... } finally { await c.close(); }`. Scheduler memakai `hooks.onClient` untuk `abort()` saat deadline — jangan bypass.

## Generator Netwatch — `netwatch.ts` MURNI

- **Tanpa import DB**/server state — fungsi murni agar skrip bisa ditest/copy-paste.
- **Pakai URL query params, BUKAN JSON body** — skrip RouterOS yang digenerate tidak punya quote dalam untuk di-escape; teks identik bekerja untuk paste manual dan install via binary API. Menambah field webhook → tambah param query, tetap tanpa quote.
- Contoh siap-tempel & skenario nyata: `docs/netwatch-examples.md`.

## Status device — boundary

- Klien ini HANYA sumber verdict; yang menulis status = **status-engine** (skill `/status-engine`). Webhook path (`routes/webhook.ts`) dan poller (`apps/worker/poller.ts`) memanggil engine yang sama — jangan `device.update({status})` di kode klien/pemanggil.
- Probe watch (`watchInterface`/`watchPort`/`watchNatDstPort`) dievaluasi di poller memakai client ini; aturannya ada di skill `/poller` + `docs/watch-modes.md`.

## Operasi aman via chat/UI

- `pingHost(ip)` dipakai command WA `PING` — berasal dari router pemilik device, bukan server NOC.
- Operasi tulis ke router (firewall block, hotspot user edit) → lewat method `MikrotikClient` dengan zod-validasi di route — ikuti `/route-guard` (perm + site scope + audit).
- Error socket (`SOCKTMOUT` dll) bisa muncul async di luar await — worker sudah punya `unhandledRejection` log-and-lanjut; jangan menambah `process.exit`.

## Resep: menambah capability RouterOS

1. Definisikan signature di `mikrotik/types.ts` (interface `MikrotikClient` + DTO di shared kalau keluar ke API/UI).
2. Implement di `v6.ts` via `node-routeros` — arg lewat `=arg=value` sentences; parse defensively (field bisa hilang di RouterOS lama).
3. Semua command lewat timeout wajar (lihat pola di `v6.ts`); jangan `await` tak berbatas di jalur poll.
4. Kalau dipakai path HTTP/WS: zod-schema di shared + route-guard + mapper strip.
5. `npm run typecheck -w @noc/server` lalu workspace pemakai.
