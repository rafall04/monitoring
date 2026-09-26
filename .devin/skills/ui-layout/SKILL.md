# Skill: ui-layout

Tata letak & sistem desain `apps/frontend` — kontrak visual yang dipakai SEMUA
halaman. Skill `/frontend` membahas data layer (TanStack Query, qk, WS patch,
api.ts); skill ini membahas **bentuk halamannya**: anatomi, responsivitas,
state loading/empty/error, dan copy Bahasa Indonesia.

## Kontrak anatomi halaman

Setiap halaman di `(app)` mengikuti kerangka yang sama — jangan menyimpang:

```tsx
<Page>
  <PageHeader
    title="…"                       // judul Bahasa Indonesia, singkat
    subtitle="…"                    // 1 kalimat: halaman ini untuk apa
    actions={<Badge …/>}            // opsional: status global / aksi utama
  />
  <PageBody>
    <Card className="p-4">          // satu topik per kartu
      <SectionHeader title="…" tone={…} action={…} />
      …konten…
    </Card>
  </PageBody>
</Page>
```

- `Page` memberi `PAGE_PAD` konsisten (padding responsif) + fade-in 180ms
  (wrapper `key={pathname}` di `(app)/layout.tsx`, mati saat
  `prefers-reduced-motion`).
- `PageBody` = kolom vertikal; jarak antar kartu dari container, **bukan**
  `mb-*` per kartu.
- Satu kartu = satu topik. Kalau kartu punya sub-blok pakai `SectionHeader`
  (`title` + `tone` dot + `action` di kanan) — bukan `<h2>` ad-hoc kecuali
  kartu tunggal sederhana.
- Aksi destruktif (hapus, logout sesi, cabut) → `variant="ghost"` +
  `text-red-400`, SELALU dengan `window.confirm` atau kalimat konsekuensi.

## Responsivitas

- **Mobile-first**: tulis layout sempit dulu, naikkan dengan `sm:`/`md:`/`lg:`.
- Grid form: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` — bukan fixed 3 kolom.
- Tabel: pakai `DataTable`/`r-table` + `TABLE.*` header style. Kolom sekunder
  wajib `hideBelow="md"`/`"lg"` — HP tidak pernah scroll horizontal untuk
  data non-esensial.
- Sentuhan: semua target interaktif pakai `noc-tap` (min 44px) — tombol kecil
  di tabel pakai `px-2 py-1` + kelas `noc-tap`.
- Sidebar collapse di `<lg`; navigasi mobile via hamburger + overlay. Safe-area
  iOS sudah ditangani (`noc-safe-top`, `viewportFit: 'cover'`).

## State — selalu keempatnya

Setiap blok data wajib punya: **loading** (`Skeleton` berbentuk konten, bukan
spinner kosong — `DataTable` punya `loading` prop yang merender skeleton
rows), **error** (`DataTable error + onRetry`, atau `EmptyState` dengan ajakan),
**empty** (`EmptyState` — kalimat memberi tahu langkah berikutnya, bukan cuma
"kosong"), **success** (toast via `useToast()` — `toast.ok`/`toast.error`).

```tsx
<DataTable dense columns={cols} rows={q.data ?? []} rowKey={r => r.id}
  loading={q.isLoading} error={q.isError} onRetry={() => void q.refetch()}
  empty="Belum ada … — tambahkan lewat …" />
```

## Role-aware layout

- **Member** (`role === 'member'`): dunianya `/akun` (hotspot/kuota/tiket/WA)
  + `/profile` (nama, departemen, password sinkron-WiFi, sesi). Nav Shell
  punya cabang member — jangan tambahkan item nav operasional untuk member.
- **Staff/operator/admin**: Overview + Sites + Operations (digate `can()`) +
  Admin. `can()` hanya menyembunyikan UI — backend tetap menegakkan.
- Konten satu halaman boleh bervariasi per role (lihat `/profile`: member
  memakai `/me/hotspot/password`, staf `/auth/change-password`) — jelaskan
  perbedaan itu DI UI, bukan menampilkan form yang salah.

## Pola yang sudah mapan — pakai, jangan bikin paralel

| Kebutuhan | Pakai |
|---|---|
| Meter kuota/progress | `UsageMeter` di `/akun` (emerald→amber>70→red>90) |
| Pill toggle flag | `FlagPill` di admin/whatsapp |
| Filter status tabs | `Tabs` di `SectionHeader action` |
| Input | `Field` + `TextInput`/`Select`/`Textarea` |
| Cari/jump | `CommandPalette` (Ctrl+K) — daftarkan halaman baru di `PAGES` |
| Status badge | `Badge` + `Tone` map konstan (`*_TONE` + `*_LABEL`) |
| Ikon nav | tambah key di `NAV_ICONS` Shell.tsx |

- Token warna: `text-slate-*`, `bg-surface*`, `border-surface-border`,
  `accent`, tone badge emerald/amber/red/sky/violet/slate. Dark+light via
  CSS var — jangan hardcode hex di komponen (kecuali inline `style` untuk
  width meter).
- Angka/teknis → `font-mono`; meta kecil → `text-2xs text-slate-500`;
  label section atas → `text-micro uppercase tracking-wide`.

## Copy Bahasa Indonesia

- Kalimat pendek, aktif, tidak teknis-berlebihan. Contoh mapan:
  "Belum ada penerima untuk X — tambahkan nomor teknisi atau grup WA di bawah."
- Kata teknis yang dibiarkan Inggris: site, router, device, alert, tiket
  (bukan karcis), broadcast, sesi.
- Konfirmasi destruktif menyebut akibatnya: "Semua perangkat lain akan
  diminta login ulang."

## Aksesibilitas

- `aria-current="page"` pada nav aktif (sudah di `item()`), `aria-label` pada
  tombol ikon-only, `<label>` via `Field`, `:focus-visible` ring global.
- `prefers-reduced-motion` dihormati oleh animasi global — jangan tambahkan
  animasi CSS/JS yang tidak mengeceknya.

## Resep: halaman baru

1. Buat `app/(app)/<nama>/page.tsx` dengan kerangka `Page/PageHeader/PageBody`.
2. Daftarkan nav di `Shell.tsx` (icon `NAV_ICONS` + gate `can()` atau cabang
   member) dan di `PAGES` `CommandPalette.tsx`.
3. Data via `qk` factory + `liteInterval` untuk polling ringan.
4. Validasi: `npm run typecheck -w @noc/frontend` → `npm run build`.
