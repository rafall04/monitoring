#!/usr/bin/env bash
# =============================================================================
# MikroTik NOC — installer for Ubuntu 20.04+ (Docker based).
#
# Easiest: just run it and answer the prompts:
#   sudo ./deploy.sh
#     - it asks for the IP or domain, detects which one, and asks ports/HTTPS.
#
# Non-interactive (automation) — pass flags instead:
#   sudo ./deploy.sh --host 172.17.11.12                      # IP, ports 3500/3600
#   sudo ./deploy.sh --host 172.17.11.12 --backend-port 3500 --frontend-port 3600
#   sudo ./deploy.sh --host sf.raf.my.id --proxy              # domain, http://
#   sudo ./deploy.sh --host sf.raf.my.id --proxy --tls        # domain, https:// (auto)
#   sudo ./deploy.sh --host 172.17.11.12 --yes                # accept all defaults
#
# Re-run any time to update — secrets + config are kept in .env.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

getenv() { if [ -f .env ]; then grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true; fi; }
is_ip_or_local() { echo "$1" | grep -qE '^([0-9]{1,3}(\.[0-9]{1,3}){3}|localhost)$'; }

# ---- start from existing .env / env (re-run keeps the previous config) ----
PUBLIC_HOST="${PUBLIC_HOST:-$(getenv PUBLIC_HOST)}"
BACKEND_PORT="${BACKEND_PORT:-$(getenv BACKEND_PORT)}"
FRONTEND_PORT="${FRONTEND_PORT:-$(getenv FRONTEND_PORT)}"
HTTP_PORT="${HTTP_PORT:-$(getenv HTTP_PORT)}"
HTTPS_PORT="${HTTPS_PORT:-$(getenv HTTPS_PORT)}"
MODE="$(getenv DEPLOY_MODE)"
TLS="$(getenv DEPLOY_TLS)"
ASSUME_YES=0

# ---- flags (optional; override the above) ----
while [ $# -gt 0 ]; do
  case "$1" in
    --host) PUBLIC_HOST="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
    --proxy) MODE="proxy"; shift ;;
    --tls) MODE="proxy"; TLS=1; shift ;;
    --http-port) HTTP_PORT="$2"; MODE="proxy"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ---- interactive setup (only when host is still unknown + a real terminal) ----
if [ -z "$PUBLIC_HOST" ] && [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  echo "──────────── Instalasi MikroTik NOC ────────────"
  DEFAULT_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  read -rp "IP atau domain server [${DEFAULT_IP:-localhost}]: " A; PUBLIC_HOST="${A:-${DEFAULT_IP:-localhost}}"
  if is_ip_or_local "$PUBLIC_HOST"; then
    MODE="direct"
    read -rp "Port web/frontend [${FRONTEND_PORT:-3600}]: " A; FRONTEND_PORT="${A:-${FRONTEND_PORT:-3600}}"
    read -rp "Port API/backend  [${BACKEND_PORT:-3500}]: " A; BACKEND_PORT="${A:-${BACKEND_PORT:-3500}}"
  else
    MODE="proxy"
    read -rp "Aktifkan HTTPS otomatis (Let's Encrypt — server harus publik & port 80/443 terbuka)? [y/T]: " A
    case "$A" in [Yy]*) TLS=1 ;; *) TLS=0 ;; esac
  fi
  echo "────────────────────────────────────────────────"
fi

# ---- final defaults ----
PUBLIC_HOST="${PUBLIC_HOST:-localhost}"
MODE="${MODE:-direct}"
TLS="${TLS:-0}"
BACKEND_PORT="${BACKEND_PORT:-3500}"
FRONTEND_PORT="${FRONTEND_PORT:-3600}"
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"

# ---- mode-specific URLs (baked into the frontend + used for CORS) ----
if [ "$MODE" = "proxy" ]; then
  COMPOSE_PROFILE="--profile proxy"
  APP_BIND="127.0.0.1:"          # apps reachable only via Caddy + localhost
  if [ "$TLS" = "1" ]; then
    CADDY_SITE_ADDRESS="$PUBLIC_HOST"
    API_URL="https://${PUBLIC_HOST}"; WEB_URL="https://${PUBLIC_HOST}"; WS_URL="wss://${PUBLIC_HOST}/ws"
  else
    CADDY_SITE_ADDRESS=":${HTTP_PORT}"
    SFX=""; [ "$HTTP_PORT" != "80" ] && SFX=":${HTTP_PORT}"
    API_URL="http://${PUBLIC_HOST}${SFX}"; WEB_URL="http://${PUBLIC_HOST}${SFX}"; WS_URL="ws://${PUBLIC_HOST}${SFX}/ws"
  fi
else
  COMPOSE_PROFILE=""
  APP_BIND=""
  CADDY_SITE_ADDRESS=":80"
  API_URL="http://${PUBLIC_HOST}:${BACKEND_PORT}"
  WEB_URL="http://${PUBLIC_HOST}:${FRONTEND_PORT}"
  WS_URL="ws://${PUBLIC_HOST}:${BACKEND_PORT}/ws"
fi

echo "==> mode=$MODE  web=$WEB_URL  api=$API_URL"

# ---- prerequisites ----
for pkg in curl openssl; do
  command -v "$pkg" >/dev/null 2>&1 || { echo "==> installing $pkg"; $SUDO apt-get update -y && $SUDO apt-get install -y "$pkg"; }
done
if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker..."
  curl -fsSL https://get.docker.com | $SUDO sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "==> installing docker compose plugin..."
  $SUDO apt-get update -y && $SUDO apt-get install -y docker-compose-plugin
fi

# ---- secrets (generated once, reused on re-run) ----
POSTGRES_USER="$(getenv POSTGRES_USER)";               POSTGRES_USER="${POSTGRES_USER:-noc}"
POSTGRES_DB="$(getenv POSTGRES_DB)";                   POSTGRES_DB="${POSTGRES_DB:-noc}"
POSTGRES_PASSWORD="$(getenv POSTGRES_PASSWORD)";       POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 16)}"
JWT_ACCESS_SECRET="$(getenv JWT_ACCESS_SECRET)";       JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-$(openssl rand -base64 48)}"
JWT_REFRESH_SECRET="$(getenv JWT_REFRESH_SECRET)";     JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-$(openssl rand -base64 48)}"
CREDENTIALS_ENC_KEY="$(getenv CREDENTIALS_ENC_KEY)";   CREDENTIALS_ENC_KEY="${CREDENTIALS_ENC_KEY:-$(openssl rand -base64 32)}"
SUPER_ADMIN_EMAIL="$(getenv SUPER_ADMIN_EMAIL)";       SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL:-admin@noc.local}"
SUPER_ADMIN_PASSWORD="$(getenv SUPER_ADMIN_PASSWORD)"; SUPER_ADMIN_PASSWORD="${SUPER_ADMIN_PASSWORD:-ChangeMe123!}"
SUPER_ADMIN_NAME="$(getenv SUPER_ADMIN_NAME)";         SUPER_ADMIN_NAME="${SUPER_ADMIN_NAME:-Super Admin}"

# ---- write .env (idempotent: secrets above are reused) ----
cat > .env <<EOF
NODE_ENV=production
LOG_LEVEL=info

# ---- Deployment mode + public URL/ports ----
DEPLOY_MODE=${MODE}
DEPLOY_TLS=${TLS}
PUBLIC_HOST=${PUBLIC_HOST}
BACKEND_PORT=${BACKEND_PORT}
FRONTEND_PORT=${FRONTEND_PORT}
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
APP_BIND=${APP_BIND}
CADDY_SITE_ADDRESS=${CADDY_SITE_ADDRESS}
PUBLIC_BASE_URL=${API_URL}
CORS_ORIGIN=${WEB_URL}

# ---- PostgreSQL ----
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public

# ---- Redis ----
REDIS_URL=redis://redis:6379

# ---- Backend ----
BACKEND_HOST=0.0.0.0

# ---- Worker ----
WORKER_HEALTH_PORT=4100
POLL_INTERVAL_DEFAULT_SEC=20
RECONCILE_INTERVAL_SEC=300
WORKER_SHARD_COUNT=1
WORKER_SHARD_INDEX=0

# ---- Auth (JWT) ----
JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d

# ---- Credential encryption (AES-256-GCM) ----
CREDENTIALS_ENC_KEY=${CREDENTIALS_ENC_KEY}

# ---- Webhook ----
WEBHOOK_IP_ALLOWLIST=

# ---- Uploads ----
UPLOAD_DIR=./uploads
MAX_UPLOAD_MB=8

# ---- First super admin (change the password after first login!) ----
SUPER_ADMIN_EMAIL=${SUPER_ADMIN_EMAIL}
SUPER_ADMIN_PASSWORD=${SUPER_ADMIN_PASSWORD}
SUPER_ADMIN_NAME=${SUPER_ADMIN_NAME}
# Set SEED_DEMO=true for sample data; leave unset for a clean production DB.

# ---- Frontend (baked into the build) ----
NEXT_PUBLIC_API_BASE_URL=${API_URL}
NEXT_PUBLIC_WS_URL=${WS_URL}
EOF
echo "==> wrote .env"

# ---- build + start ----
$SUDO docker compose ${COMPOSE_PROFILE} up -d --build

PORTS_NOTE="${FRONTEND_PORT} and ${BACKEND_PORT}"
[ "$MODE" = "proxy" ] && { PORTS_NOTE="${HTTP_PORT}"; [ "$TLS" = "1" ] && PORTS_NOTE="${HTTP_PORT} and ${HTTPS_PORT}"; }

cat <<EOF

============================================================
 MikroTik NOC deployed  (mode: ${MODE}$([ "$TLS" = "1" ] && echo " + TLS"))
   Open     : ${WEB_URL}
   Backend  : ${API_URL}
   Login    : ${SUPER_ADMIN_EMAIL} / ${SUPER_ADMIN_PASSWORD}

 Migrations + seed run automatically on the backend container.
 Open the firewall for port(s): ${PORTS_NOTE}
$([ "$TLS" = "1" ] && echo " HTTPS needs ${PUBLIC_HOST} to resolve to this server and ports 80/443 reachable for Let's Encrypt.")
 Logs:   docker compose ${COMPOSE_PROFILE} logs -f
 Stop:   docker compose ${COMPOSE_PROFILE} down
 Update: git pull && sudo ./deploy.sh        # re-uses your saved .env config
============================================================
EOF
