# UI Redesign — Audit & Spec

Analysis basis: production `172.17.41.3:2222` (`/root/monitoring`), commit `a09c2f4` —
**identical to local `main`**, so the local tree is exactly what production renders.
Baseline: `typecheck` passes across all 5 workspaces.

## 1. Production reality (what the design must actually fit)

| Fact | Value |
|---|---|
| Sites | 5 (SF 1–5), **all `mapMode: floorplan`**, all `region` empty |
| Devices | 197 — SF1 **70**, SF2 37, SF5 41, SF4 25, SF3 24 |
| Device types | gtex 124, qcpad 52, androidtv 13, other 8 |
| Areas / Lines | 14 areas (4 `lines` + 10 `room`) / 34 lines |
| Ruijie | 43 routers (AP+switch), 139 ports |
| Status events | 77,432 |
| App users | 5 (2 super_admin, 1 operator, 2 viewer) |
| Manual overrides | **0** — the `maintenance` display state is never exercised in prod |

Consequences for the redesign:

- **`region` is empty on every site.** The Overview groups by region and renders a
  single `SectionHeader` labelled *"Tanpa kabupaten"* wrapping all 5 cards — a
  section header that adds a heading, a rule and a rollup row while conveying
  nothing. The grouping layer is pure overhead at current scale.
- **`mapMode` is `floorplan` everywhere.** The `geo`/`denah` badge on every
  Overview card is a constant — 5 identical badges, zero information.
- **SF 5 is 41/41 down**, SF1 18 down, SF2 15, SF3 9, SF4 10 → **93 of 197 devices
  down (47%)**. The "currently down" list on each Overview card truncates at 3
  (`+38 lagi…`). The dashboard's dominant real state is *mass red*, which the
  current card design (thin 1.5px bar + 3-item list) communicates poorly.
- Density target is **~70 devices per site**, not ~10. Line/Area view and the
  floorplan carry the load.

## 2. Structural findings (root causes of "tidak rapi")

### 2.1 No design tokens — `tailwind.config.ts` extends **colors only**

The theme extends `surface{,-raised,-border}` + `accent`. There is **no spacing,
radius, or typography scale**. Nothing constrains drift, and the values drifted:

| Axis | Distinct values in use | Detail |
|---|---|---|
| Font size | **10** | `text-xs` ×151, `text-sm` ×95, `text-[10px]` ×34, `text-[11px]` ×33, `text-[9px]` ×1, + base/lg/xl/2xl/3xl |
| Radius | **7** | `rounded` ×43, `rounded-full` ×36, `rounded-lg` ×33, `rounded-md` ×7, `rounded-xl` ×5, `rounded-2xl` ×2, `rounded-sm` ×1 |
| Padding | **10** | `p-4` ×41, `p-3` ×21, `p-2` ×11, `p-6` ×5, `p-5` ×5, `p-0` ×5, `p-1.5` ×3, `p-8`, `p-3.5`, `p-1` |
| Vertical rhythm | **8** | `space-y-` 0.5 / 1 / 1.5 / 2 / 3 / 4 / 5 / 6 |
| Gap | **7** | `gap-2` ×103, `gap-3` ×37, `gap-1.5` ×14, `gap-1` ×9, `gap-4` ×2, `gap-2.5` ×2, `gap-0.5` ×2 |

Four sub-14px font sizes (9/10/11/12px) is the single most visible precision
defect — labels that should align optically do not.

### 2.2 Light mode is systematically broken

`globals.css` re-tones `text-slate-100…500` for light mode, but **only slate**.
Semantic status colors are untouched:

- **108** uses of `text-{red,amber,emerald,sky,violet,rose}-{300,400}`
- **only 29** carry a `dark:` prefix
- → **79 color-text utilities render at dark-mode brightness on white surfaces**

`ui.tsx`'s `TONES` map solved this correctly (`text-red-700 dark:text-red-400`),
but the pages that bypass `<Badge>` re-broke it. Worst: `alerts` (10),
`diagnostics` (9), `ruijie-ports` (8), `ruijie` (7), `hotspot` (7), `admin/sites` (7).

### 2.3 `PageHeader actions` is overloaded

`actions` is a flex-wrap bar sized for a tab strip or one button. Payloads by
inspection:

| Page | Contents | Verdict |
|---|---|---|
| `sites/[siteId]` | 4 badges + % pill + WiFi link + 3 tabs + Legend + 2 buttons | **overloaded — up to 11 controls** |
| `admin/audit` | entity + action filter `<Select>`s | filters belong in the body |
| `access-control` | router `<Select>` | filter belongs in the body |
| `admin/users` | one `<Button>` | fine |
| `hotspot` | one `<Tabs>` | fine |

`sites/[siteId]` is the primary operator screen: with a long site name its
header wraps to 2–3 rows, and the sticky header eats vertical space the
floorplan needs.

### 2.4 Three competing idioms for the same thing

**Filter bars** — no primitive; each page rolls its own:
- `admin/users`: bare `flex flex-wrap gap-2` + `text-xs text-slate-500` count
- `alerts`: `flex flex-wrap gap-3 text-sm` + ad-hoc colored pills as counts

**Tables** — no primitive; 6 tables, **7 distinct `<th>` class combos**
(`py-1` ×7, `px-2` ×5, `text-right` ×4, `px-3 py-2` ×2, `px-4 py-2`, `px-3`,
`px-3 text-right`) and 4 `<td>` padding variants:

| Page | Card padding | Cell padding | `r-table` (mobile stacking) |
|---|---|---|---|
| `admin/users` | `p-4` | `py-1.5` | ✅ |
| `alerts` (×2) | `p-0` | `px-3 py-2` | ❌ |
| `admin/audit` | — | — | ✅ |
| `hotspot` (×4) | — | — | ✅ |
| `admin/ruijie` | — | — | ❌ |
| `reports` | — | — | ❌ |

4 of 9 tables have no mobile treatment and fall back to horizontal scroll.

**Badges** — `<Badge>` exists; **10 sites re-implement it** with 2 radii
(`rounded` vs `rounded-full`), 3 paddings (`px-2 py-1`, `px-2 py-0.5`,
`px-1.5 py-0.5`) and 3 font sizes.

**Section titles** — `<SectionHeader>` used 9×; **22 ad-hoc `<h2>/<h3>`** across
**10 different class combos** (`text-base`/`text-sm`/`text-lg`/default ×
`slate-100`/`slate-200`).

**Buttons** — `ruijie/page.tsx` hand-rolls the "Switch" link
(`rounded-lg border border-surface-border bg-surface/60 px-3 py-1.5 text-sm`)
instead of `<Button variant="secondary">`, so it does not match any other button.

### 2.5 Responsive is incoherent

```
page                     sm:  md:  lg:  xl:
alerts                    0    0    0    0
hotspot                   0    0    0    0
reports                   0    0    0    0
sites/[siteId]            5    0    0    0
admin/settings            6    0    2    0
```

- **`md:` is used 0 times in all 18 pages** — yet `Shell` switches the sidebar at
  `md:` (`md:static md:flex md:w-60`). Between 640–768px the sidebar is still a
  drawer while content has already gone 2-up. The two breakpoint systems never
  meet.
- **`alerts`, `hotspot`, `reports` have zero breakpoints** — desktop-only, relying
  on 8 `overflow-x-auto` escape hatches.
- **`xl:`/`2xl:` essentially unused.** Default `PageBody` width is `max-w-6xl`
  (1152px); only 4 pages opt into `wide` (1280px). On the 1920–2560px displays a
  NOC actually runs, ~40% of the viewport is dead margin.

### 2.6 Spacing bugs

`PageBody` applies `space-y-6`; children then add their own margins, producing
inconsistent gaps:
- `ruijie/page.tsx:113` — `<Card className="mb-4 p-4">` → 24px + 16px = 40px
- `admin/sites/page.tsx:172,202` — `mb-4` grids inside the same `space-y-6`

### 2.7 Sidebar does not scale

`Shell` lists **every site individually** — currently Overview + 5 sites + 7
operations + 5 admin = **18 items**, no search, no collapse, no per-site health
indicator. At 10+ sites this becomes a scrolling wall.

## 3. What is already right (keep)

- `Page` / `PageHeader` / `PageBody` are used by **18/18 pages** — the skeleton is sound.
- `ErrorState` vs `EmptyState` separation (a failed fetch never reads as "nothing down").
- `TONES` map with mode-aware foregrounds — correct, just under-used.
- `r-table` stacking pattern — correct, just inconsistently applied.
- `effectiveStatus()` folding for status display.

## 4. Redesign spec

### Phase 1 — tokens (`tailwind.config.ts` + `globals.css`)
1. Type scale, replacing all arbitrary `text-[9/10/11px]`:
   `micro` 11px/16 · `xs` 12px/18 · `sm` 13px/20 · `base` 14px/22 · `lg` 16px/24 ·
   `xl` 20px/28 · `2xl` 26px/32
2. Radius: `sm` 6 · `DEFAULT/lg` 8 · `xl` 12 · `full`. Ban bare `rounded` (4px).
3. Spacing: card padding **`p-4` only** (`p-3` for dense/nested); section gap `space-y-5`;
   inline gap `gap-2` / `gap-3`.
4. **Extend `globals.css` light-mode re-toning to semantic colors**, so
   `text-red-400` etc. resolve to a readable `-700` on white — fixes 79 sites without
   touching them.

### Phase 2 — primitives (`components/ui.tsx`)
- `<DataTable>` — one table shell: header/cell padding, zebra/hover, `r-table` stacking,
  right-aligned action column, empty/error slots. Replaces 9 hand-built tables.
- `<FilterBar>` — search + selects + result count, one layout.
- `<Toolbar>` — the "stats + tabs + actions" row, moved **out of** `PageHeader` into the
  body so the header stays title+subtitle+primary-action only.
- `<StatStrip>` — the badge/percentage cluster used on Overview and site header.
- Widen `PageWidth`: `default` → `max-w-[1400px]`, add `xl:`/`2xl:` grid steps.

### Phase 3 — page rewrites (18 pages)
Priority by operator value:
1. `sites/[siteId]` — split the 11-control header; give the floorplan its height back
2. `page.tsx` (Overview) — drop the empty-region grouping and the constant `mapMode`
   badge; make mass-down states legible at 47% down
3. `alerts`, `hotspot`, `reports` — add responsive layouts (currently zero breakpoints)
4. `admin/users`, `admin/sites` — move the 103-line actions block into the body
5. `ruijie`, `ruijie/switches`, `ruijie/[project]` — `<Badge>`/`<Button>` compliance
6. Remainder — token + primitive compliance pass

### Verification gate
`npm run typecheck` + `npm run build` (what CI runs). No test runner exists.
