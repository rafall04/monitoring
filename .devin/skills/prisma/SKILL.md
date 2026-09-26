---
name: prisma
description: Aturan schema & data (packages/server/prisma) — gotcha generate sebelum typecheck, migrasi dev vs prod, konvensi model (@@map, Json, index retensi), secrets encrypt-on-write + mapper strip, dan pola delete besar
argument-hint: "[topik: schema|migrate|secret|dto]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: Prisma & Data Model (packages/server/prisma)

Satu schema untuk semua workspace: `prisma/schema.prisma`, client di-consume lewat `@noc/server` (`prisma` singleton). Jawab Bahasa Indonesia.

## Gotcha nomor satu

**`npm run prisma:generate` WAJIB sebelum typecheck/build** — `@noc/server` mengimport tipe `@prisma/client`; checkout segar gagal `tsc` tanpa generate. CI melakukannya eksplisit (lihat skill `/verify`).

## Migrasi

- Dev: `npm run prisma:migrate` (create migration + apply).
- Prod/CI: `npm run prisma:deploy` — apply tanpa prompt; `deploy.sh` menjalankannya di dalam build image → migrasi ikut deploy otomatis. Sebutkan di commit bila ada migrasi.
- Jangan `db push` di prod; jangan edit file migrasi yang sudah ter-apply — buat migrasi baru.

## Konvensi model

- Tabel snake_case lewat `@@map("nama_tabel")`; kolom camelCase di kode.
- Kolom fleksibel pakai `Json?` (contoh: `AppUser.scopeSiteIds` → `string[]`, `Device.watchAlertWindow` → `AlertWindow`) — di kode selalu `as string[]`-cast defensif, lihat `scoped()` di commands.
- Field yang di-sweep retensi PUNYA index pada kolom waktunya (`StatusEvent.occurredAt`, `AuditLog.createdAt`, `RefreshToken.expiresAt`) — menambah tabel append-only → index kolom waktu + daftarkan ke `RetentionSweeper`.
- Foreign key cascade disengaja (Site→Router→Device `onDelete: Cascade`); `SetNull` untuk referensi opsional (`Ticket.memberId`, `Device.areaId`). Pikirkan onDelete saat menambah relasi — jangan default.
- `Setting` = satu row `id="global"` (white-label + default operasional) — baca via `getSettings()` singleton, jangan query langsung di tiap call.
- Nullable membawa makna, jangan "merapikan" tanpa paham: `Ticket.reporterPhone` null = laporan web (status hanya di portal); `WaRecipient.kind` number|group menentukan format `target` (digits vs JID).

## Secrets — tidak pernah keluar ke klien

- Password router & token Telegram **encrypt-on-write** AES-256-GCM (`crypto.ts`, format `v1:<iv>:<tag>:<ct>`, key `CREDENTIALS_ENC_KEY`). Field baru yang bernilai secret → encrypt saat write.
- **DTO mappers** (`mappers.ts`) yang men-strip — API expose boolean `hasXxxSecret`, TIDAK PERNAH ciphertext/plaintext. Menambah field secret → update mapper + DTO type di shared.
- `clientForRouter` satu-satunya tempat `decryptSecret` untuk password router (lihat `/mikrotik`).

## Pola akses yang benar

- Query lintas tenant SELALU lewat scope: `siteScopeFor`/`siteScopeWhere`/`canAccessSite`/`assertSiteAccess` — aturan lengkap di `/route-guard`.
- Hapus massal (retensi, cleanup) → `deleteInBatches` (~500 row/statement + pause) — `deleteMany` raksasa mengunci tabel di DB besar.
- Klaim idempoten pakai `updateMany` dengan kondisi (lihat `escalatedAt` di `ticket-escalator.ts`) — aman untuk race antar instance.
- `AppUser.phone` unik-per-identitas: relink WA nomor = `updateMany` lepas dari akun lain + `phoneVerifiedAt` baru (pola di `LINK` router wabot).

## Resep: kolom/tabel baru

1. Edit `schema.prisma` + `prisma migrate dev --name <maksud>` (dev) → file migrasi ikut commit.
2. `npm run prisma:generate` → typecheck.
3. Update: DTO mapper (strip kalau secret), zod schema shared bila keluar ke API, query-key frontend bila dibaca UI.
4. Append-only/event-like → index waktu + evaluasi retensi.
5. Gate: `prisma:generate` → `typecheck` → `build` (`/verify`).
