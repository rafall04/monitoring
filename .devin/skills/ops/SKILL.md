---
name: ops
description: Runbook diagnosis produksi NOC — tangga cek untuk "alert/tiket tidak sampai", "bot diam", "status device aneh", "router offline", dan "grup tidak terima" lewat health endpoint, Redis keys, wa_message, dan pola log
argument-hint: "[gejala]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
---

# Skill: Runbook Operasional (diagnosis produksi)

Tangga cek dari gejala ke akar masalah. Semua perintah lewat helper SSH (lihat skill `/deploy`): `python _ssh.py "<cmd>"`. Prinsip: **cek fakta dulu, baru opini** — jangan loncat ke "restart" sebelum tahu tahap mana yang putus.

## Pipa end-to-end yang bisa putus di mana saja

```
Netwatch/probe → status-engine → notify/enqueue → wa_message row + noc:wa:outbox
              → wabot BLPOP → Baileys → WA user/grup
inbound → InboundRouter → waSeen dedup → waRate → dispatch → reply
```

Setiap gejala = salah satu mata rantai. Cari mata rantainya dulu.

## "Bot WA tidak menjawab chat"

1. `docker exec mikrotik-noc-wabot-1 node -e "fetch('http://localhost:4200/health').then(r=>r.text()).then(console.log)"` — `waConnected` + `session.status` + `session.error`.
2. `session.status='offline'` → `docker logs mikrotik-noc-wabot-1 --tail 50` cari `code`/`reason` (401=pairing, 515=normal restart, 428/440=koneksi).
3. Connected tapi diam → pesan kemungkinan: dedup `noc:wa:seen:<id>` (re-delivery), rate-limit `noc:wa:rate:<phone>` (30/mnt), grup non-command (memang diam by design), atau `fromMe`.
4. Perintah staff tak jalan → nomor belum `phoneVerifiedAt` (LINK dulu) atau role/scope kurang — cek `appUser.phone/role/scopeSiteIds`.
5. Rate notice: sejak batch conversational UX, pengirim dapat kartu 🐢 sekali/menit (`noc:wa:rate-note:`) — bukan diam total.

## "Alert device/tiket tidak sampai ke WA"

1. `wa_message` row: `status queued|sent|failed|dead` + `attempts` — `dead` = 5x gagal (nomor salah/JID grup invalid). Perbaiki penyebab lalu `KIRIMULANG <id>` dari chat admin (atau `WADEAD` untuk daftar) — row `dead` tidak auto-retry.
2. Kedalaman `noc:wa:outbox` naik → wabot macet/disconnect (cek health).
3. Tidak ada row sama sekali → produsen yang menahan:
   - Alert: `isCritical` off? `manualOverride='maintenance'`? `silencedUntil` masih aktif? alert window (uplinkAlert*/watchAlertWindow)? `noc:wacooldown:<dev>:<status>` EX 90 NX masih terisi (anti-flap)?
   - Tiket: `Setting.waComplaintEnabled`? `WaRecipient{isActive,tickets:true}` ada untuk site? recipients `kind='group'` target JID harus ada di `noc:wa:groups` cache (bot harus MEMBER grup).
4. Transisi: alert hanya di perubahan status — device yang sudah down tidak re-alert (kecuali window catch-up).
5. `docker logs mikrotik-noc-wabot-1 | grep level\":[45]0` — `rate-overlimit` = fetch grup loop (sudah difix throttle 30s; bila masih muncul, cek versi).

## "Grup tidak menerima forward / PROSES di grup tidak jalan"

1. `noc:wa:groups` — JID grup ada di cache? Bot harus anggota; kosong → `refreshGroups` via control `groups-refresh` atau tunggu event.
2. `PROSES` di grup dijawab "Bukan teknisi" → nomor **participant** bukan `WaRecipient` site itu / bukan staff scoped. Otorisasi = `msg.sender` (participant/participantAlt), bukan JID grup.
3. Read commands grup (`TIKET/DOWN/...`) hanya untuk AppUser terverifikasi non-member — recipient tanpa akun pakai private chat.
4. Command tak dikenal di grup = diam (by design, no probing).

## "Status device aneh / dashboard bohong"

1. `effectiveStatus(status, manualOverride)` — `status` mentah jangan dibaca sendiri; maintenance menang.
2. Device `unknown` massal satu site → router offline: log worker `'reconciled devices to unknown (router offline)'` + `'router poll failed (circuit breaker engaged)'`. Itu OUTAGE nyata, bukan bug. Transisi router kini juga mengirim `🔴 SITE OFFLINE`/`🟢 SITE ONLINE` ke `alerts:true` recipients + TG (cooldown `noc:*cooldown:router:*` EX 300) — tak ada alert saat flip? cek key cooldown + `whatsappMode`/`telegramMode` site.
3. Device dengan `watchInterface|watchPort|watchNatDstPort` → verdict milik probe; Netwatch tidak boleh menimpanya (cek exclude di `applyDeviceStatusesByHost`).
4. Status berubah tapi tidak ada event → cek `statusSince`/`StatusEvent` terakhir; publisher ada di status-engine saja.

## "Tiket numpuk open / eskalasi tidak jalan"

- `ticket.escalatedAt` set SEKALI per tiket (`Setting.waTicketEscalateMin`; 0=off). Eskalator jalan di worker primary shard tiap 60s — `docker logs mikrotik-noc-worker-1 | grep escalation`.

## Perintah sikat cepat

```bash
# warn/error semua service inti
for c in wabot worker backend; do echo "== $c"; docker logs mikrotik-noc-$c-1 --tail 200 2>&1 | grep '"level":[45]0' | tail -8; done
# health semua app
for p in 4000 4100 4200; do curl -s localhost:$p/health; done   # (di host hanya yang dipublish; else docker exec)
# redis: antrean + cooldown
docker exec mikrotik-noc-redis-1 redis-cli LLEN noc:wa:outbox
docker exec mikrotik-noc-redis-1 redis-cli KEYS 'noc:wacooldown:*'
docker exec mikrotik-noc-redis-1 redis-cli GET noc:wa:session
```

## Aturan etika ops

- Jangan `docker restart` sebelum log dibaca — restart menghapus jejak.
- Jangan wipe `noc:wa:session`/`wa_auth_key` — memicu re-pairing QR.
- Perubahan data langsung ke DB = opsi terakhir + selalu `AuditLog`/catat di laporan ke user.
