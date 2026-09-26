---
name: route-guard
description: Resep menambah endpoint Fastify / command bot baru dengan benar — authenticate + requirePermission + site scope (assertSiteAccess/siteScopeWhere), validasi zod, dan aturan secrets
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

# Skill: Guard Endpoint & Command

Gunakan setiap kali menambah/mengubah: route `apps/backend/src/routes/*`, permission baru di RBAC, command staff di wabot, atau field yang mengandung secret.

## Dua lapisan izin — keduanya wajib

RBAC di repo ini **dua level terpisah**; permission saja TIDAK cukup:

1. **Role-level** — permission string dari matriks `packages/shared/src/rbac.ts` (`hasPermission`).
2. **Site-level** — scope situs user (`scopeSiteIds`), dicek eksplisit di handler setelah `siteId` target diketahui. Lupa cek ini = bug akses lintas-site yang paling gampang terjadi.

## Pola endpoint Fastify

Guard composition standar (`apps/backend/src/plugins/rbac.ts`):

```ts
const view = {
  onRequest: [authenticate],                          // verifikasi JWT + reload snapshot user FRESH
  preHandler: [requirePermission('map:view')],        // cek role-level dulu
};

// List → batasi query pakai siteScopeWhere ({} untuk super_admin)
app.get('/', view, async (req) => {
  const where = siteScopeWhere(req.appUser);
  return prisma.thing.findMany({ where: where.siteId ? { siteId: where.siteId } : {} });
});

// Resource tunggal → assertSiteAccess SETELAH siteId diketahui
app.get('/:id', view, async (req) => {
  const { id } = idParamSchema.parse(req.params);
  const row = await prisma.thing.findUnique({ where: { id } });
  if (!row) throw notFound('...');
  assertSiteAccess(req.appUser, row.siteId);          // ← jangan lupa ini
  return toThingDto(row);
});
```

- `authenticate` me-reload `req.appUser` **fresh setiap request** — role/scope/deaktivasi berlaku seketika. Jangan cache snapshot user.
- Error helper ada di `apps/backend/src/lib/errors` (`notFound`, `forbidden`, `badRequest`, dst.) — pakai itu, jangan `reply.code(...)` manual.
- Body/params divalidasi **zod** dari `@noc/shared` `schemas.ts` — `schema.parse(req.body)`; tipe inferred dipakai ulang form frontend. Endpoint baru → tambah/reuse schema di shared, jangan inline `as` cast.

## Permission baru

Tambah di SATU tempat: matriks `packages/shared/src/rbac.ts`. Frontend memakai `can()` hanya untuk **menyembunyikan UI** — backend tetap yang menegakkan. Setelah menambah permission, update juga halaman yang memakai `can('<perm>')` dan `need[]` map di `apps/wabot/src/router.ts` bila command bot ikut.

## Command bot (wabot) — padanannya

- Cek `hasPermission(user.role, perm)` lewat map `need` di `router.ts` sebelum handler.
- Di handler `commands/staff.ts`: `siteScopeFor(scoped(user))` untuk list, `canAccessSite(u, siteId)` untuk target tunggal — helper sama persis dari `@noc/shared`.
- Detail lengkap: skill `/wabot`.

## Secrets tidak pernah keluar server

- Field secret (password router, token bot): encrypt saat tulis via `encryptSecret` (`packages/server/src/crypto.ts`, AES-256-GCM, format `v1:<iv>:<tag>:<ct>`, kunci `CREDENTIALS_ENC_KEY`).
- DTO **mappers** (`packages/server/src/mappers.ts`) wajib membuang ciphertext — API hanya expose boolean seperti `hasTelegramToken`. Field secret baru = encrypt-on-write + mapper omit. Jangan pernah return ciphertext/plaintext secret di respons.

## Audit

Mutasi penting tulis `AuditLog` (`action`, `entity`, `entityId`, `after`). Dari jalur bot pakai varian tanpa `req` (`via: 'whatsapp'`).

## Checklist endpoint baru

1. `{ onRequest: [authenticate], preHandler: [requirePermission('<perm>')] }`.
2. `assertSiteAccess` / `siteScopeWhere` di handler — uji dengan user operator ber-scope sempit.
3. Validasi zod untuk params+body; DTO mapper untuk respons.
4. Permission ditambah di `rbac.ts` bila perlu; UI gate `can()` selaras.
5. `npm run typecheck -w @noc/backend` → tutup `npm run typecheck` penuh (`/verify`).
