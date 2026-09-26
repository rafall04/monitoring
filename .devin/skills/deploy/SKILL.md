---
name: deploy
description: Deploy produksi NOC ke Docker host via SSH — alur git pull + deploy.sh --yes, wajib systemd-run agar survive disconnect, verifikasi container/health/log, dan aturan port/keamanan
argument-hint: "[host?]"
allowed-tools:
  - read
  - grep
  - glob
  - exec
---

# Skill: Deploy Produksi

Alur deploy yang terbukti bekerja di proyek ini. Server: `root@192.168.102.100:2222` (password disimpan user, bukan repo). Repo server: `/root/monitoring` branch `main`.

## Akses SSH dari box ini

Tidak ada `sshpass`/`plink` — pakai helper `C:\project\sf\_ssh.py` (paramiko, host+port+kredensial sudah tertanam, `get_pty=True`, timeout 300s):

```bash
cd /c/project/sf && python _ssh.py "<command>"
```

## Prosedur deploy (WAJIB urut)

```bash
# 1. Cek state server: branch + working tree bersih
python _ssh.py "cd /root/monitoring && git fetch origin && git status --short && git log --oneline -2"

# 2. Pull fast-forward (jangan merge/commit di server)
python _ssh.py "cd /root/monitoring && git pull --ff-only origin main"

# 3. Deploy via systemd-run — PENTING
python _ssh.py "cd /root/monitoring && systemd-run --unit=noc-deploy.service \
  bash -c './deploy.sh --yes > /root/deploy-noc.log 2>&1'"
```

### Kenapa `systemd-run` dan BUKAN nohup/&

sshd server membunuh proses grup sesi saat SSH tutup (`KillUserProcesses`) — `nohup cmd &` dan background pipeline **mati di tengah build** tanpa jejak (log kosong, PID hilang). `systemd-run` menjalankan job di scope sendiri → survive disconnect. Ini sudah terbukti gagal 2x sebelum fix.

## Menunggu & verifikasi

```bash
# Poll sampai 'inactive' (build ~3-5 menit)
python _ssh.py "systemctl is-active noc-deploy.service; tail -15 /root/deploy-noc.log"

# Semua container harus healthy
python _ssh.py "docker ps --format '{{.Names}} {{.Status}}' | grep mikrotik"

# Health wabot — port 4200 TIDAK dipublish ke host, exec dari dalam container
python _ssh.py "docker exec mikrotik-noc-wabot-1 node -e \
  \"fetch('http://localhost:4200/health').then(r=>r.text()).then(t=>console.log(t))\""

# Scan log level 40/50 (warn/error) tiap service
python _ssh.py "docker logs mikrotik-noc-wabot-1 --tail 100 2>&1 | grep '\"level\":[45]0' | tail -10"
```

Checklist health wabot: `status:"ok"`, `waConnected:true`, `session.status:"connected"`, phone+name terisi, `error:null`.

## Aturan

- **Jangan deploy lewat SSH foreground** — build 3-5 menit; koneksi putus = setengah deploy.
- **Jangan commit di server** — repo produksi harus `git status` bersih sebelum pull; bila kotor, selidiki dulu (pernah `checkout --` hanya setelah yakin).
- **`git pull --ff-only`** — bila gagal, server divergen; jangan force.
- Compose: `mikrotik-noc-{postgres,redis,backend,worker,wabot,frontend,backup}-1`. Postgres/Redis **tidak** di-recreate oleh deploy.
- `deploy.sh` menjalankan `prisma deploy` di dalam build image — migrasi ikut otomatis; tetap umumkan di pesan commit bila ada migrasi.
- Port app dipublish semua interface kecuali `--app-bind 127.0.0.1` (deploy.sh baris TIP menyarankannya). Health port service = internal saja — verifikasi via `docker exec`, jangan `curl localhost` dari host.
- Nilai yang pernah diverifikasi: wabot `waConnected:true` phone `6285137501184` ("IT SF"), 7 container healthy.

## deploy.sh — flag berguna

| Flag | Fungsi |
|---|---|
| `--yes` / `-y` | skip prompt, reuse `.env` tersimpan (untuk update routine) |
| `--app-bind 127.0.0.1` | publish port app hanya ke localhost (di balik proxy) |
| `--frontend-port`, `--tls/--no-tls` | first-run networking |

Update rutin persis yang tertulis di akhir deploy.sh: `git pull && sudo ./deploy.sh --yes`.

## Rollback

```bash
python _ssh.py "cd /root/monitoring && git log --oneline -5"     # temukan SHA sehat
python _ssh.py "cd /root/monitoring && git checkout <sha> -- . 2>/dev/null || git checkout <sha>"
# lalu systemd-run deploy seperti di atas; kembali ke main setelah selesai:
python _ssh.py "cd /root/monitoring && git checkout main"
```
