# WhatsApp Bot Multi-Guna — Mega Plan

Status: **terimplementasi (Fase 0–4)** — fondasi, alert, self-service, tiket,
eskalasi, broadcast, dan perintah staff sudah di codebase. Validasi mesin lokal:
`typecheck` + `next build` hijau; jalur live (Postgres/Redis/Baileys) diverifikasi
di Docker host.

Keputusan yang sudah dikunci:

| Keputusan | Pilihan |
|---|---|
| Transport WhatsApp | **Baileys** (unofficial, QR pairing), dibungkus interface `WhatsAppSender` agar adapter Cloud API bisa drop-in nanti |
| Proses | **`apps/wabot`** — workspace ke-6, service compose sendiri, single instance (tidak di-shard) |
| Tiket komplain | **Penuh**: model `Ticket`, forward ke teknisi, reply `PROSES`/`SELESAI`, eskalasi, halaman `/tickets` di NOC |
| Pengerjaan | Bertahap per fase (lihat §5), plan ini disimpan dulu |

---

## 1. Kenapa Baileys (bukan Cloud API / gateway lokal)

- Deploy model repo ini self-hosted Docker single-server. Baileys tidak butuh domain publik atau webhook inbound (Cloud API butuh keduanya + verify token Meta).
- Use-case utama — alert ke teknisi & forward komplain — adalah **pesan yang diinisiasi server**. Di Cloud API itu wajib template berbayar di luar window 24 jam; di Baileys free-form dan gratis.
- Risiko Baileys (ban nomor, breaking change saat WA ubah protokol) dimitigasi: nomor dedikasi, tidak kirim pesan massal unsolicited, dan **semua call site bicara lewat `WhatsAppSender`** — migrasi ke Cloud API nanti hanya menulis adapter baru, tidak menyentuh fitur. Preseden yang sama: `MikrotikClient` (v6 implement, v7 stub).

## 2. Arsitektur

```
webhook / poller
      │ status change
      ▼
 status-engine ──▶ notify.ts (dispatcher)
      │                ├── maybeNotifyTelegram  (existing, untouched)
      │                └── enqueueWaAlert ──▶ LPUSH noc:wa:outbox
      │                                                  │
      ▼                                           BLPOP  ▼
 Redis cache + site events                     ┌──────────────┐
                                               │  apps/wabot  │──▶ WhatsApp
                                               │  (Baileys)   │◀── inbound
                                               └──────┬───────┘
                                                      │ prisma + clientForRouter
                                                      ▼
                                            command router: status / kick /
                                            komplain / PROSES / SELESAI / menu
```

**Alasan proses terpisah (bukan digabung `apps/worker`):**

- Baileys memelihara WebSocket persisten + session state + reconnect loop sendiri. Menggabungnya ke worker berarti instabilitas sesi WA ikut menggoyang poller — padahal poller sengaja dibangun anti-crash.
- Worker di-shard; bot **tidak boleh** di-shard (satu nomor = satu sesi). Proses sendiri menghapus kelas bug "shard mana pegang sesi".
- Crash/restart terisolasi, `/health` sendiri, statistik sendiri.

**Outbox = Redis List (`noc:wa:outbox`), BUKAN pub/sub.** Kalau bot sedang reconnect, alert tetap antre dan terkirim setelah hidup lagi. Pub/sub akan drop pesan — untuk alert outage itu bug. Payload di-retry dengan backoff; setelah N kali gagal → status `dead` di `WaMessage` + log.

**Inbound:** wabot menerima pesan → command router → pakai `prisma` + `clientForRouter` langsung (pola yang sama dengan `me-hotspot.ts`, minus Fastify). State percakapan multi-langkah (intake komplain anonim) disimpan di Redis `noc:wa:conv:<phone>` TTL 15 menit.

## 3. Perubahan data model

```prisma
model Site {
  // ... field existing tetap
  whatsappMode     String  @default("off") // off | server — mirror telegramMode
  waRecipients     WaRecipient[]
  tickets          Ticket[]
}

// Penerima alert/komplain per site — sengaja decoupled dari AppUser
// (teknisi lapangan sering tidak punya akun NOC). kind=number → target adalah
// nomor 628xxx; kind=group → target adalah JID grup yang DIPILIH dari daftar
// grup yang bot ikuti (cache noc:wa:groups via groupFetchAllParticipating).
model WaRecipient {
  id       String  @id @default(cuid())
  siteId   String
  site     Site    @relation(fields: [siteId], references: [id], onDelete: Cascade)
  name     String
  kind     String  @default("number") // number | group
  target   String  // number → 628xxx · group → JID …@g.us (dari pick-list)
  role     String  @default("technician") // technician | manager | noc
  alerts   Boolean @default(true)  // terima alert device down/up
  tickets  Boolean @default(true)  // terima forward komplain
  isActive Boolean @default(true)

  @@index([siteId])
  @@map("wa_recipient")
}

model AppUser {
  // ... field existing tetap
  phone           String?   // E.164 — link identitas WA (member DAN staff)
  phoneVerifiedAt DateTime? // null = belum terverifikasi, bot abaikan
}

model Ticket {
  id            String    @id @default(cuid())
  siteId        String
  site          Site      @relation(fields: [siteId], references: [id], onDelete: Cascade)
  memberId      String?   // AppUser member bila nomor ter-link; null = anonim
  reporterPhone String
  reporterName  String?
  category      String    @default("gangguan") // gangguan | lambat | voucher | lainnya
  message       String
  status        String    @default("open") // open | ack | resolved
  handledBy     String?   // nama teknisi / AppUser yang PROSES/SELESAI
  createdAt     DateTime  @default(now())
  resolvedAt    DateTime?

  @@index([siteId, status])
  @@index([createdAt])
  @@map("ticket")
}

// Auth state Baileys di DB (encrypted) → survive rebuild container tanpa volume.
// Baileys auth = creds + banyak key; satu row per key.
model WaAuthKey {
  key       String @id
  valueEnc  String // AES-256-GCM via crypto.ts yang sudah ada
  updatedAt DateTime @updatedAt

  @@map("wa_auth_key")
}

// Log semua pesan keluar: audit, debug, dan anti-duplikat retry.
model WaMessage {
  id        String   @id @default(cuid())
  to        String   // JID tujuan
  kind      String   // alert | ticket-forward | reply | broadcast
  body      String
  status    String   // queued | sent | failed | dead
  siteId    String?
  attempts  Int      @default(0)
  createdAt DateTime @default(now())

  @@index([createdAt])
  @@map("wa_message")
}
```

`Setting` tambahan: `waDownTemplate`, `waUpTemplate` (reuse `renderTemplate` + placeholder `{device}{ip}{site}{status}{when}` yang sama), `waBotName` (default nama org), `waComplaintEnabled`, `waTicketEscalateMin`.

## 4. Desain lintas-fitur

- **Alert gate identik dengan Telegram**: hanya `isCritical`, skip `manualOverride='maintenance'`, hormati `silencedUntil`, hanya transisi `down` dan recovery `up`. Cooldown anti-flap terpisah: `noc:wacooldown:<device>:<status>` EX 90 NX. Device "pantau interface uplink" (`Device.watchInterface`) menambah satu gate: alert hanya dalam jam kerja (`Setting.uplinkAlert*` global atau `Device.watchAlertWindow` per-device) — status tetap update 24/7, dan catch-up "masih down saat jam buka" dikirim sekali per window (`uplink.ts`).
- **Identitas = nomor HP, terverifikasi.** Member link nomor via kode OTP yang digenerate di halaman `/me` portal → kirim `LINK <kode>` ke bot (atau admin assign + member konfirmasi). Nomor belum verified → bot hanya melayani menu publik (komplain), tidak ada perintah akun. Staff (operator+) link dengan cara yang sama → command staff ikut `hasPermission` + `canAccessSite` (operator hanya melihat site-nya).
- **Sensitif tetap di portal**: ganti password TIDAK lewat chat (plaintext di WA buruk) — bot balas link portal. Operasi bot dibatasi read-status + kick sesi.
- **Anti-spam**: rate limit inbound per nomor (Redis counter), cooldown per command, nomor tak dikenal hanya dapat alur komplain.
- **Ironi alert**: kalau sesi WA mati, channel alert ikut mati. Mitigasi: `waConnected` di `/health` wabot + fallback — sesi down >5 mnt kirim warning via Telegram bila terkonfigurasi.
- **Audit**: semua aksi bot menulis `AuditLog` (buat varian `writeAudit` tanpa `req`, actor = member/system).
- **Mock driver**: `WA_DRIVER=mock` → `MockSender` log ke pino, inbound disimulasikan via endpoint debug — seluruh jalur testable di dev box tanpa nomor WA (konsisten dengan `.preview/mock.mjs`).
- **i18n**: semua balasan bot Bahasa Indonesia, konsisten dengan UI.
- **Sesi persisten**: `WaAuthKey` di DB (encrypted), jadi rebuild container tidak minta scan QR ulang. Pairing: backend serve QR/pairing-code → halaman admin `/settings/whatsapp` tampilkan QR untuk discan — tidak perlu SSH.

## 5. Fase pengerjaan

### Fase 0 — Fondasi ✅
- `packages/shared/src/wa.ts`: payload outbox, command types, zod schemas (`siteWaConfigSchema`, `siteContactSchema`, `ticket*`).
- `packages/server/src/wa/`: `WhatsAppSender` interface, `enqueueWa()` (LPUSH + row `WaMessage`), `MockSender`.
- `apps/wabot`: bootstrap, Baileys socket, DB auth state, reconnect loop, `unhandledRejection`/`uncaughtException` handlers (copy pola worker), BLPOP consumer + retry/dead-letter, `/health` dengan `waConnected`.
- Schema + migration model di atas; field `Setting`.
- Compose service `wabot` + env `WA_ENABLED`, `WA_DRIVER`; Dockerfile (alpine + openssl seperti backend).
- Backend routes `whatsapp.ts`: status sesi + QR untuk UI pairing.
- UI: tab WhatsApp di Settings (QR pairing, status koneksi).

### Fase 1 — Alert jaringan ✅
- `Site.whatsappMode` + CRUD `SiteContact` (API `site-contacts.ts` + UI per-site).
- `notify.ts` → dispatcher `maybeNotifyAlert`: telegram path existing + `enqueueWaAlert` (ke `SiteContact{alerts:true}` + `whatsappGroupJid`).
- Templates WA di Settings UI.

### Fase 2 — Self-service hotspot via WA ✅
- Ekstrak logika `me-hotspot.ts` → `packages/server/src/member-service.ts` (satu sumber kebenaran web + bot).
- Linking nomor (OTP via portal) + field `phone`/`phoneVerifiedAt`.
- Command member: `menu`, `status`, `logout`/`kick`, `info`, `bantuan`.
- Command staff (role≥operator, scope-aware): `down`, `status <site>`, `ack <device>`.

### Fase 3 — Tiket komplain ✅
- `komplain <pesan>` untuk nomor ter-link (konteks member otomatis terlampir).
- Intake state machine: **nama → departemen → site → pesan** (anonim); member tertaut tanpa dept ditanya sekali → tersimpan di `AppUser.department`.
- Member juga komplain dari web: `POST/GET /me/tickets` (kartu di `/akun`) — satu implementasi `createAndForwardTicket` (`@noc/server` ticket-service); `reporterPhone` nullable untuk pelapor web tanpa WA.
- `TIKET` — member cek status komplain sendiri dari WA.
- Forward ke `WaRecipient{tickets:true}`: `🎫 TIKET #id — nama · dept · phone (site)\n"pesan"\nBalas: PROSES id / SELESAI id`.
- Reply `PROSES`/`SELESAI` → update status + notifikasi ke pelapor (di-skip bila `reporterPhone` null).
- Worker sweep: `open` > `waTicketEscalateMin` → eskalasi ke `role=manager`/grup.
- Halaman `/tickets` di frontend (kolom Pelapor = `nama · dept`) + permission `tickets:view`/`tickets:manage` di `rbac.ts` + API `tickets.ts`.

### Fase 4 — Ekstensi ✅ (voucher tetap backlog)
- ✅ Broadcast pengumuman per site (`POST /whatsapp/broadcast` + UI di Settings), enqueue per-target lewat outbox.
- ⏳ Request voucher via WA → jalur `vouchers` existing → kirim credential (approval manual dulu).
- ✅ `laporan` → digest 24 jam (site health + tiket terbuka) ke staff.
- ✅ `ping <ip>` untuk teknisi (reuse `pingHost` diagnostics, scope-checked).
- ⏳ Adapter Cloud API di belakang `WhatsAppSender` bila perlu migrasi resmi.

## 6. File map

```
packages/shared/src/wa.ts                    payload, command types, zod schemas
packages/shared/src/rbac.ts                  + tickets:view / tickets:manage
packages/shared/src/events.ts                + REDIS_KEYS waOutbox/conv/cooldown
packages/server/src/wa/{sender,outbox}.ts    interface + enqueue + MockSender
packages/server/src/notify.ts                dispatcher telegram + WA
packages/server/src/member-service.ts        ekstraksi logika me-hotspot
packages/server/prisma/schema.prisma         + SiteContact, Ticket, WaAuthKey, WaMessage
apps/wabot/package.json + Dockerfile         workspace @noc/wabot
apps/wabot/src/index.ts                      bootstrap + reconnect + health
apps/wabot/src/session.ts                    Baileys auth state ↔ WaAuthKey
apps/wabot/src/outbox.ts                     BLPOP consumer + retry/dead-letter
apps/wabot/src/router.ts                     command dispatch + rate limit + dedup
apps/wabot/src/commands/{member,staff}.ts    member self-service + staff commands
apps/wabot/src/tickets.ts                    create + forward + PROSES/SELESAI
apps/wabot/src/intake.ts                     state machine komplain anonim
apps/backend/src/routes/whatsapp.ts          status sesi, QR, test send, broadcast
apps/backend/src/routes/site-contacts.ts     CRUD SiteContact
apps/backend/src/routes/tickets.ts           list/update tiket untuk web
apps/backend/src/routes/me.ts                /me/wa + link-code (member & staff)
apps/worker/src/ticket-escalator.ts          sweep open>N mnt → ping manager
apps/frontend/…                              kartu WA (QR+broadcast), /tickets,
                                             kontak per-site, link code di akun/profile
docker-compose.yml, deploy.sh                service wabot + env baru
```

## 7. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Ban nomor (Baileys unofficial) | Nomor dedikasi, tidak broadcast unsolicited, interface `WhatsAppSender` siap migrasi |
| Sesi WA putus = alert hilang | Outbox list (bukan pub/sub) + `waConnected` health + fallback warning Telegram |
| Nomor HP dibajak/diganti | Verifikasi OTP; operasi sensitif tetap di portal; audit semua aksi |
| Bot dipakai spam command | Rate limit per nomor; nomor anonim hanya jalur komplain |
| Duplikat alert Telegram+WA | Per-channel on/off per site; operator pilih channel per contact |
| Rebuild container minta QR ulang | Auth state di DB (`WaAuthKey`, encrypted) |

## 8. Validasi

- Gate yang sama dengan CI: `npm run prisma:generate` → `typecheck` → `build`.
- `WA_DRIVER=mock` untuk dev box (tanpa WA/Postgres/Redis penuh tetap bisa typecheck + UI).
- Path DB/Redis/Baileys live diverifikasi di Docker host, bukan di mesin dev ini.
