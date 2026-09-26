---
name: wabot
description: Expert WhatsApp bot (apps/wabot) — arsitektur, katalog perintah, resep tambah command, security model, Redis keys, dan quirk pairing Baileys
argument-hint: "[topik: command|session|outbox|intake|deploy]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: WhatsApp Bot (apps/wabot)

Gunakan skill ini setiap kali bekerja pada `apps/wabot`, endpoint WA di backend, atau fitur yang mengirim/menerima pesan WhatsApp. Semua jawaban ke user ditulis **Bahasa Indonesia**, dan balasan bot juga Indonesia (konsisten UI).

## Peta arsitektur

```
producer (status-engine/notify, ticket-service, admin broadcast)
   │ enqueueWaMessage → row wa_message + LPUSH
   ▼
noc:wa:outbox (Redis LIST — bukan pub/sub; pesan antre saat bot mati)
   │ BLPOP (koneksi dedikasi, commandTimeout 30s — default 5s race dengan BLPOP)
   ▼
apps/wabot ── sender WhatsAppSender ──▶ WhatsApp
   ▲                                        │ inbound messages.upsert
   └── InboundRouter ◀──────────────────────┘
         (private chat penuh; grup = surface sempit PROSES/SELESAI + staff read)
```

- **Single instance SAJA** — sesi WA tidak bisa di-shard. Jangan pernah menambah replica.
- **3 koneksi Redis** di `src/index.ts`: `redisPub` (publish/session/rate), `redisOutbox` (BLPOP), `redisControl` (BLPOP). Dua BLPOP **wajib** `commandTimeout: 30_000`.
- **`WhatsAppSender`** interface di `@noc/shared` (`wa.ts`). 3 implementasi: `BaileysSender` (`src/baileys.ts`), `MockWaSender` (`@noc/server` — `WA_DRIVER=mock`), `OfflineWaSender` (index.ts — `WA_ENABLED=false`, outbox → `dead`).
- **File map**: `index.ts` bootstrap+health · `baileys.ts` socket lifecycle + normalisasi inbound (`remoteJidAlt`/`participantAlt` untuk @lid) · `session.ts` auth state ke tabel `wa_auth_key` (AES-256-GCM) · `outbox.ts` konsumen outbox · `control.ts` konsumen `noc:wa:control` · `router.ts` dispatch perintah (private `handle()` + grup `handleGroup()`) · `intake.ts` wizard multi-langkah · `tickets.ts` PROSES/SELESAI (`from` otorisasi, `replyTo` tujuan) + `BotCtx` · `commands/member.ts`, `commands/staff.ts` · `fmt.ts` `card()`/`DIV`/`cmd()`.
- Referensi desain lengkap: `docs/whatsapp-bot-plan.md`.

## Urutan dispatch di router.ts (PENTING — urutan berpengaruh)

0. **Pesan grup** → `handleGroup`: surface sempit — `PROSES|SELESAI <kode>` (otorisasi nomor pengirim `msg.sender` = WaRecipient site tiket / staff scope) + read commands `sites|status|down|cek|tiket|laporan` (verified staff saja, silent bila gagal). Balasan ke JID grup. Member/publik tidak pernah lewat grup. Identitas pengirim grup = `participant` JID (`participantAlt` untuk @lid).
1. Dedup `waSeen(messageId)` EX 300 NX. Rate limit 30/menit/nomor (`waRate`).
2. `LINK <kode>` → `consumeWaLinkCode` (kode dari portal `/me`) — satu nomor = satu identitas (nomor dilepas dari akun lain).
3. `PROSES|SELESAI [kode] [catatan]` → `handleTicketCommand` (teknisi). Kode boleh kosong bila pesan me-reply kartu tiket (`quotedText` membawa `#CODE`); catatan ikut ke audit + notifikasi pelapor (`notifyReporter(note)`).
4. **Percakapan pending** `waConv(phone)` → `continueIntake` (menelan teks bebas — selalu cek sebelum identitas).
5. Lookup `AppUser` by `phone` + `phoneVerifiedAt != null` + `isActive`.
6. `KOMPLAIN|LAPOR|KELUHAN|PENGADUAN|GANGGUAN [teks]` → `startComplaint` (butuh `Setting.waComplaintEnabled`; member → jalur member, staff → wizard anon pre-fill nama/dept dari akun).
7. `DAFTAR` → `startRegister`.
8. `ping` (non-staff), greeting `menu|help|bantuan|...` → menu per role; `INFO` universal (kartu portal/kontak, tanpa akun pun bisa).
9. Belum ter-link → `publicIntent()` (kata kunci gangguan/voucher/akun) → **WaRecipient scope** (nomor terdaftar di `wa_recipient` tanpa akun → read ops `sites|down|cek|tiket|laporan` terbatas site-nya via pseudo `ScopedUser{role:'viewer'}`) → `TIKET` (tiket anon per `reporterPhone`) → menu publik.
10. Member → `status|akun|kuota|profil`, `logout|kick|keluar`, `tiket`, `info` di `commands/member.ts`.
11. Staff → regex `(sites|status|down|ack|unack|cek|ping|tiket|tickets|laporan|maint|maintenance|aktif|silent|unsilent|bunyi|bot|botstatus|wastatus|wadead|kirimulang)` → cek `need[cmd]` permission via `hasPermission` → `commands/staff.ts`.
    - `MAINT|AKTIF` = `manualOverride` maintenance + `publishSiteEvent`/`publishSiteSummary` (mirror PATCH /devices) — perm `device:edit-attributes`. Prefix `SITE` = `updateMany` seluruh device site + satu summary (tanpa event per-device).
    - `SILENT <nama> [menit]`/`BUNYI` = `silencedUntil` (mirror /incidents/:id/silence) — perm `alerts:manage`. `SILENT SITE <nama> [menit]` = versi massal.
    - `UNACK` lepas ack — perm `alerts:manage`. `TIKET <kode>` = detail tiket — perm `tickets:view`; `TIKET` bare + quoted card = detail kartu itu.
    - Lookup device (`pickDevice`, `CEK`) cocokkan nama **atau** `ipAddress`; hasil ambigu menawarkan numbered pick (`waPick`) — `staffPickResolve` di router menelan balasan digit (private staff saja; grup/recipient tidak menawarkan pick).
    - `BOTSTATUS` = sesi WA + kedalaman outbox + statistik `wa_message` 24j + wizard aktif — perm `whatsapp:manage`.
    - `WADEAD` = daftar `wa_message` status `dead` (5x gagal); `KIRIMULANG <id-prefix>` reset attempts → `queued` + LPUSH ulang payload `{id,to,text:body,kind,siteId}` ke `noc:wa:outbox` — perm `whatsapp:manage`.
    - Handler baca (`staffSites/Down/Cek/Tickets/Report`) menerima `ScopedUser` (bukan AppUser) agar dipakai ulang surface grup/recipient — dispatch bersama lewat `staffRead()`. Handler tulis (`Ack/Unack/Maint/Silent/Ping`) tetap `AppUser` (butuh id/nama untuk audit) dan private-only.

## Security model (jangan dilanggar)

- Grup hanya surface sempit (`PROSES`/`SELESAI` + read ops staff terverifikasi); semua flow member/publik/pick/privasi lain **hanya private chat**. Otorisasi grup = nomor `sender` participant, bukan JID grup.
- Nomor tak dikenal: hanya jalur komplain/register/menu publik — tidak pernah bocorkan data staff/member.
- Member hanya menyentuh akun hotspot **miliknya** (`hotspotRouterId` + `hotspotUsername`) — pola `withMemberRouter`.
- Staff: `siteScopeFor`/`canAccessSite` dari `@noc/shared` — permission role-level + scope site-level sama-sama dicek.
- `PROSES`/`SELESAI`: otorisasi = nomor ada di `WaRecipient{kind:'number'}` site tiket ATAU staff `canAccessSite`.
- **Tidak ada operasi sensitif via chat** (ganti password → arahkan ke portal). Aksi mutasi tulis `AuditLog` (`via: 'whatsapp'`).

## Redis keys (`REDIS_KEYS` di `@noc/shared` events.ts — jangan hardcode)

| Key | Fungsi |
|---|---|
| `noc:wa:outbox` | LIST outbound (LPUSH producer → BLPOP wabot) |
| `noc:wa:control` | op admin: `logout` (unlink+wipe keys→QR baru), `reconnect` (soft restart), `groups-refresh` |
| `noc:wa:session` | snapshot `WaSessionState` untuk UI pairing (status: qr/connecting/connected/offline/disabled) |
| `noc:wa:groups` | cache grup yang bot ikuti → pick-list `WaRecipient{kind:'group'}` |
| `noc:wa:conv:<phone>` | state wizard, TTL 15 mnt (`WA_CONV_TTL_SEC`) |
| `noc:wa:ident:<phone>` | cache nama/dept pelapor anon, 30 hari |
| `noc:wa:rate:<phone>` | rate limit inbound |
| `noc:wa:seen:<msgId>` | dedup re-delivery WA |
| `noc:wacooldown:<dev>:<st>` | anti-flap alert (EX 90 NX) |
| `noc:wa:pick:<phone>` | pending numbered pick setelah lookup ambigu (JSON `{action,deviceIds,minutes?}`, EX 120) — balasan digit memilih kandidat |
| `noc:wa:rate-note:<phone>` | throttle notice "terlalu cepat" (NX EX 60 — kabari 1x/menit, bukan per pesan) |

## Tiket (jalur bersama web)

- `createAndForwardTicket` (`@noc/server` `ticket-service.ts`) dipakai **bot DAN** `POST /me/tickets` — format forward identik. Jangan duplikasi logikanya.
- Forward ke semua `WaRecipient{isActive, tickets:true}` site (number + group JID).
- `reporterPhone` nullable (laporan web tanpa WA) — `notifyReporter` skip bila null.
- Eskalasi `open` > `Setting.waTicketEscalateMin` → `apps/worker/src/ticket-escalator.ts`.

## Quirk Baileys yang sudah di-handle (baca sebelum mengubah baileys.ts)

- **Group-refresh feedback loop**: `groupFetchAllParticipating` memicu `groups.update` lagi → debounce re-arm → loop fetch tiap ~2,3 dtk sampai `rate-overlimit`. `refreshGroups` punya floor 30 dtk untuk event-driven; control op (tombol ⟳ admin) pakai `force`.
- **Presence & read receipts** di upsert: `readMessages` (centang biru) + `composing` sebelum dispatch, `paused` setelah — bot terasa hidup. Jangan pindahkan ke router (butuh `sock`).
- **515 → 401 death loop**: `restartRequired` (515) itu NORMAL pasca-pairing — flush `credsSave` DULU baru reconnect, kalau tidak WA balas 401. 401 dalam 120 detik setelah 515 = pembersihan slot lama, retry sekali, JANGAN wipe keys.
- `loggedOut` sungguhan → `clearDbAuthState` + kosongkan `waGroups` → QR baru.
- `deadSocks` WeakSet: socket yang dibunuh `logout()`/`reconnect()` tidak boleh memicu reconnect ganda (orphan QR race).
- `connecting` single-flight — caller konkuren berbagi connect yang sama.
- `qrTimeout: 60_000` (UI polling); `fetchLatestWaWebVersion` > `fetchLatestBaileysVersion` (GitHub scrape bisa basi — issue #2679), dibatasi race 10s.
- JID `@lid`: pakai `remoteJidAlt` untuk `from`, jangan balas ke bare LID.
- `unhandledRejection`/`uncaughtException` di index.ts log-dan-lanjut — bot tidak boleh crash-loop.

## Resep: menambah perintah bot

1. Tentukan kategori: publik / member / staff / teknisi.
2. Tambah regex/cabang di `dispatch()` `router.ts` pada posisi yang benar (setelah cek `conv` bila command tidak boleh tertelan wizard).
3. Staff: tambah entry `need: Record<string, Permission>` + case di switch + handler di `commands/staff.ts` (selalu `siteScopeFor`/`canAccessSite`). Member: handler di `commands/member.ts` via `withMemberRouter`.
4. Perbarui `MEMBER_MENU`/`STAFF_MENU`/menu publik agar command terdokumentasi di balasan MENU.
5. Format balasan pakai `card(title, body, hint?)` + `DIV`/`cmd()` dari `fmt.ts` — jangan rakit string sendiri.
6. Bila mengirim pesan ke user lain → lewat `enqueueWaMessage` (audit `wa_message`), jangan `sender.sendText` langsung dari luar wabot.
7. Aksi mutasi → `AuditLog` dengan `via: 'whatsapp'`.
8. Validasi: `npm run typecheck -w @noc/wabot` (dan `-w @noc/server`/`-w @noc/shared` bila disentuh).

## Operasional

- Env: `WA_ENABLED`, `WA_DRIVER=baileys|mock`, `WABOT_HEALTH_PORT` (default per env.ts). `WA_DRIVER=mock` menjalankan seluruh jalur tanpa nomor WA.
- `/health` expose `waConnected` + `session` — cek ini dulu saat "alert tidak sampai".
- Debug pengiriman: lihat `wa_message.status` (`queued|sent|failed|dead`, `attempts`) — `dead` berarti 5x gagal.
- Dev `npm run dev:wabot` (tsx watch). Di box ini tanpa Docker hanya typecheck yang bisa diverifikasi — jalur Postgres/Redis/Baileys dites di Docker host.
