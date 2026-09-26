---
name: verify
description: Jalankan gate validasi repo ini — prisma:generate → typecheck → next build (persis seperti CI), termasuk mode single-workspace
allowed-tools:
  - read
  - exec
---

# Skill: Gate Validasi Repo

Repo ini **tidak punya test runner** — jangan cari `npm test`. Gate yang dipakai CI (`.github/workflows/ci.yml`) dan yang harus dijalankan sebelum klaim selesai:

```bash
npm run prisma:generate   # WAJIB dulu — @noc/server import tipe @prisma/client
npm run typecheck         # tsc --noEmit ke-6 workspace — gate utama
npm run build             # next build (frontend SAJA — bukan build semua)
```

## Aturan main

- **Urutan wajib**: `prisma:generate` dulu. Checkout baru selalu gagal `tsc` sebelum client digenerate.
- Jalankan dari root repo (`monitoring/`). Semua perintah di atas ada di root `package.json`.
- `npm run build` ≠ build semuanya — service Node (backend/worker/wabot) jalan via `tsx`, tidak pernah dibundle. Yang dibuild hanya frontend.
- Bila mengubah `packages/server/prisma/schema.prisma`: `prisma:migrate` (dev) atau `prisma:deploy` (prod), lalu `prisma:generate` lagi.

## Typecheck satu workspace (lebih cepat saat iterasi)

```bash
npm run typecheck -w @noc/wabot      # apps/wabot
npm run typecheck -w @noc/backend    # apps/backend
npm run typecheck -w @noc/worker     # apps/worker
npm run typecheck -w @noc/frontend   # apps/frontend
npm run typecheck -w @noc/shared     # packages/shared
npm run typecheck -w @noc/server     # packages/server
```

Scopekan ke workspace yang disentuh dulu, tapi **selalu tutup dengan `npm run typecheck` penuh** — `shared`/`server` diimpor lintas workspace sebagai `.ts` mentah, jadi error bisa muncul di konsumen, bukan di file yang diubah.

## Batasan mesin dev ini

Box ini hanya punya Node 20 + git — **tidak ada Docker/Postgres/Redis**. Yang bisa diverifikasi lokal: `typecheck` + `next build`. Jalur DB/Redis/MikroTik/Baileys live harus dites di Docker host — sebutkan ini apa adanya saat melapor, jangan klaim sudah dites.

## UI preview (bila perlu cek frontend)

- `node .preview/mock.mjs` — mock Fastify seluruh `/api/v1` di port 4000.
- `next start` untuk preview (lihat `.claude/launch.json`).
- Gotcha: `next dev` menimpa `.next` produksi (menghapus `BUILD_ID`) — selalu `next build` ulang sebelum `next start`. Screenshot timeout di env ini; pakai `preview_eval`/`preview_inspect`.

## Cara melapor

Laporkan per langkah: PASS/FAIL + error pertama yang relevan. Bila FAIL, berhenti dan perbaiki sebelum lanjut langkah berikutnya — jangan lompat ke build saat typecheck masih merah.
