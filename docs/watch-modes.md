# Watch modes — empat cara memantau device

Dok operasional untuk mode pemantauan device. Semua konfigurasi dilakukan dari
panel device (klik marker → **Pantauan lanjutan**) dan field-nya tersimpan di
`Device` (`packages/server/prisma/schema.prisma`). Eksekusi probe ada di worker:
`apps/worker/src/poller.ts`, satu kali per siklus poll router.

---

## 1. Empat cara memantau device

| Mode | Field `Device` | Sumber kebenaran | `source` di StatusEvent | Menjawab |
| ---- | -------------- | ---------------- | ----------------------- | -------- |
| **Netwatch (ping)** | — (default) | Entry `/tool/netwatch` di router ping `ipAddress` | `webhook` / `polling` | "host hidup?" |
| **Interface router** | `watchInterface` | Flag `running` dari `/interface/print` di router | `interface` | "port/link-nya UP?" — tidak butuh IP sama sekali |
| **Port TCP** | `watchPort` | Koneksi TCP dari **server NOC** ke `ipAddress:watchPort` (timeout 4 dtk) | `tcp` | "host up tapi service mati" — ping hijau, aplikasi tidak merespons |
| **Forward NAT (traffic)** | `watchNatDstPort` + `watchNatStaleMin` | Counter `bytes` pada rule `dstnat` dengan `dst-port` tsb di `/ip firewall nat` | `traffic` | "forward hidup tapi data tidak mengalir" — rule ada, service listen, tapi tidak ada trafik lewat |

Catatan umum:

- Tiga mode terakhir disebut **probe devices**. Verdict mereka ditulis lewat
  status-engine yang sama dengan Netwatch, jadi marker, status event, realtime
  WS, dan alert berperilaku identik — hanya `source`-nya yang berbeda.
- Device probe **dikeluarkan dari rekonsiliasi Netwatch**: status-engine tidak
  mencocokkan mereka by-host (`watchInterface`/`watchPort`/`watchNatDstPort`
  harus `null` di `applyDeviceStatusesByHost`), jadi entry Netwatch pada IP
  yang sama tidak bisa menimpa verdict probe.
- Ketiga field watch **mutually exclusive** — mengisi salah satu membersihkan
  dua lainnya (UI maupun backend menegakkan ini).
- Selain `source` probe, `StatusEvent.source` juga bisa bernilai `webhook`
  (Netwatch realtime) atau `polling` (rekonsiliasi Netwatch). Enum
  `STATUS_SOURCES` (`packages/shared/src/types.ts`) masih mencadangkan
  `manual` — terdefinisi tapi belum ada penulisnya saat ini.

---

## 2. Forward NAT watch — memantau trafik forward itu sendiri

Motivasi: dst-nat yang di-disable atau dibuat ulang meninggalkan ping dan probe
TCP tetap hijau (dst-address masih merespons port-nya sendiri, atau host target
masih hidup), sementara forward datanya mati. Watch ini tidak percaya "port
merespons" — ia membaca **counter `bytes` rule-nya**.

Cara pasang: pada device, pilih mode **Forward NAT (traffic)**, lalu isi
**Dst-port forward** dengan `dst-port` pada rule `dst-nat` di router tempat
device itu berada (`routerId`), dan opsional **Stall setelah (menit)**.

Logika verdict per poll (`pollNatTraffic` di `poller.ts`):

| Kondisi rule/counter | Verdict |
| -------------------- | ------- |
| Tidak ada rule `dstnat` dengan `dst-port` tsb | `unknown` — config drift, tampil di peta tanpa teriak outage |
| Rule ada tapi `disabled` | `down` — **kasus insiden**: forward OFF |
| `bytes` bertambah sejak poll terakhir | `up` — data benar-benar mengalir |
| `bytes` diam | `up` selama masih dalam masa grace; `down` bila tidak tumbuh > `watchNatStaleMin` menit (**default 5** bila field *Stall setelah* kosong) |
| `bytes` turun (rule dibuat ulang / router reboot) | re-baseline: `up` bila counter sudah > 0, `unknown` bila masih 0 |
| Observasi pertama (belum ada baseline) | `unknown` — satu pembacaan tidak bisa membuktikan aliran; verdict jujur, bukan tebakan hijau |

Detail implementasi:

- Baseline (`bytes`, `firstSeenAt`, `lastGrowthAt`) disimpan per-device di Redis
  `noc:device:<id>:natwatch` dan ditulis ulang tiap poll — bertahan lintas
  restart worker, hilang bersih bila Redis di-flush (poll berikutnya baseline
  ulang secara `unknown`, bukan false-alert).
- Rule hilang atau disabled juga menghapus baseline — rule yang dibuat ulang
  selalu me-reset counter ke 0, jadi baseline lama tidak valid.
- Rule di-identifikasi murni lewat `chain=dstnat` + `dst-port`; dua rule pada
  port yang sama berbagi verdict (ambil yang pertama ketemu).

---

## 3. Drift watch — perubahan konfig firewall

Terpisah dari status device: `RouterMikrotik.watchConfig` (default **on**)
membuat worker, di tiap poll router, men-snapshot tabel firewall dan mem-diff
terhadap snapshot terakhir di Redis (`noc:router:<id>:cfgsnap`).
Implementasi: `packages/server/src/config-watch.ts` (`checkConfigDrift`).

- Menu yang dipantau: **`nat`, `filter`, `mangle`** (`/ip firewall …` via API
  biner — bukan polling SNMP/dsb).
- Pada diff apapun (rule ditambah `+`, dihapus `-`, atau field berubah `~`,
  mis. `disabled=false→true`), tiga hal terjadi sekaligus:
  1. Row `audit_log` dengan action **`router.config-change`** (terlihat di
     admin audit viewer),
  2. Event WS **`router.config`** → toast live di UI ("Konfig `<router>`
     berubah: …"),
  3. Alert **Telegram** bila `site.telegramMode='server'` dan **WhatsApp**
     ke recipient `alerts=true` bila `site.whatsappMode='server'`
     (pesan "⚠️ CONFIG BERUBAH — site / router" berisi s/d 12 baris diff).
- **Dikecualikan dari diff** (agar tidak self-alert / noise):
  - rule kelolaan NOC — `comment` diawali `NOC` atau `chain` diawali `noc-`,
  - rule `dynamic` (churn konstan),
  - field volatile `bytes`, `packets`, `last-seen`, `last-hit-time` — counter
    trafik berdetak terus; memasukkannya membuat tiap poll jadi diff semu.
- Poll pertama setelah fitur aktif (atau setelah snapshot hilang) hanya
  menyimpan baseline — **tidak pernah** mengirim "seluruh tabel berubah".
- **Opt-out per router**: Admin → Sites & Routers → edit router → uncheck
  *"Pantau perubahan konfig firewall (drift alert)"*. Centang mengaktifkannya
  kembali (baseline ulang dari poll berikutnya).

Drift watch tidak mengubah status device apapun — ia pelengkap: NAT traffic
watch di §2 adalah yang mengubah status device saat rule forward mati.

---

## 4. Alert gating — jam kerja + gate standar

Semua probe device (`watchInterface` | `watchPort` | `watchNatDstPort`)
berbagi **work-hours alert window** (`resolveUplinkWindow` di
`packages/server/src/uplink.ts`):

- Default global: `Setting.uplinkAlert{Start,End}Min/Days` — diatur di
  **Admin → Settings → "Jam alert uplink (jam kerja)"** (bawaan 06:00–18:00,
  Sen–Min).
- Override per-device: `watchAlertWindow` — centang **"Jam alert khusus device
  ini"** di panel device. Mendukung window lintas-tengah-malam (mis. 18:00 →
  06:00).
- **Status tetap di-update 24/7** — window hanya menahan notifikasi. Di luar
  window, `notify.ts` menekan alert Telegram+WA; `uplinkWindowCatchUp`
  mengirim satu alert "masih down saat window dibuka" (dedup per window
  instance lewat flag Redis `noc:uplink:alerted:*` TTL 20 jam — jadi down
  semalaman = satu alert pagi, bukan spam).
- Gate **standar tetap berlaku** di atas window (`maybeNotifyTelegram` /
  `maybeNotifyWhatsApp`): hanya device `isCritical` yang alert;
  `manualOverride='maintenance'` dan `silencedUntil` menekan sepenuhnya; site
  `telegramMode`/`whatsappMode` harus `server`; dan ada cooldown anti-flap 90
  detik per device+status. Catch-up melewati gate yang sama — operator yang
  me-mute device tidak bisa "ditelpon" lewat jalur belakang.

Netwatch biasa **tidak** kena window — ia alert 24/7 sesuai gate standar.

---

## 5. Contoh use-case — "China SQL forward"

Insiden yang memotivasi fitur ini: seseorang me-**disable** rule dst-nat
`dst-port=21433 → to-ports=1433` di router **SF1** pukul ~18:39. Feed SQL ke
China mati semalaman tanpa ada yang sadar — ping tetap hijau, Netwatch tidak
punya apa-apa untuk dilaporkan.

Pemasangan yang menutup celah itu:

1. Buat device **"China SQL forward"** di site SF1, `routerId` = router SF1.
   `ipAddress` boleh diisi IP server SQL (untuk label/konteks) — watch ini
   tidak membutuhkannya.
2. **Pantauan lanjutan → Forward NAT (traffic)**: `Dst-port forward` =
   `21433`, `Stall setelah (menit)` = `5` (atau sesuai ritme trafik feed).
3. Tandai `isCritical` agar lolos gate alert.

Akibatnya tiga lapis pengaman menutup insiden yang sama:

- **Saat kejadian**: drift watch langsung berbunyi — diff
  `nat *… dstnat … dpt=21433→1433: disabled=false→true` masuk audit
  `router.config-change`, toast `router.config` muncul di semua layar NOC yang
  membuka site, dan Telegram/WA terkirim (relay `server`).
- **Deteksi status**: poll berikutnya membaca rule `disabled` → device
  **"China SQL forward" turun ke `down` dengan `source=traffic`** — bukan
  menunggu stall timer (disabled = mati seketika, bukan "belum ada trafik").
  Status baru pulih saat rule di-enable DAN counter kembali berdetak.
- **Varian halus**: bila rule tidak di-disable tapi dibuat ulang salah arah
  (atau upstream-nya mati sehingga tidak ada flow), counter diam → `down`
  setelah > 5 menit tanpa pertumbuhan `bytes`.

---

## 6. Batasan

- **Ritme = poll router.** Semua probe jalan di dalam `pollRouter`, per siklus
  poll router itu (`pollIntervalSec`, default dari `Setting.defaultPollSec`)
  — bukan timer independen. Router mati = probe tidak jalan; scheduler
  tetap me-reconcile device ke `unknown` lewat jalur circuit-breaker seperti
  biasa.
- **Sequential per router.** Di dalam satu poll, tahap jalan berurutan:
  netwatch reconcile → interface watch → drift watch → TCP watch → NAT
  traffic watch, dan probe TCP/NAT di-loop per device satu per satu
  (bukan paralel). Router dengan banyak probe bertambah durasi poll-nya;
  deadline poll (`pollDeadlineMs`) tetap berlaku untuk keseluruhan.
- **Probe aux tidak pernah mematikan poll.** `checkConfigDrift`,
  `pollTcpDevices`, dan `pollNatTraffic` masing-masing `.catch`-wrapped —
  bug di dalamnya hanya menghasilkan warn log, tidak pernah membuat circuit
  breaker menandai router sehat sebagai offline.
- **Disabled ≠ stall.** Rule dst-nat `disabled` langsung `down` di poll
  pertama yang melihatnya — *Stall setelah* hanya berlaku untuk counter yang
  diam pada rule **enabled**. Begitu pula rule hilang → `unknown` langsung.
- **TCP probe dari server NOC**, bukan dari router — ia mengukur path
  server→`ip:port` apa adanya. VRF/firewall antar segmen yang memblokir NOC
  akan terbaca `down`. Tanpa `ipAddress`, probe TCP tidak punya sasaran dan
  verdict selalu `unknown`.
- **Satu `dst-port` = satu device.** Watch mengambil rule `dstnat` pertama
  yang cocok; topologi dengan banyak rule pada satu port (per-IP splitting)
  hanya terpantau sepotong.
- **Bukan bandwidth monitor.** `bytes` hanya dibandingkan naik/diam/turun —
  forward yang tersendat (throughput drop tapi masih mengalir) tetap `up`.
