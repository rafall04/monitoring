#!/usr/bin/env bash
# =============================================================================
# MikroTik NOC — installer for Ubuntu 20.04+ (Docker based).
#
# Easiest: just run it and answer the prompts (asked EVERY run, so you can change
# the ports any time):
#   sudo ./deploy.sh
#     - Alamat akses (IP atau domain)
#     - Port frontend / web   (default 3600, customizable)
#     - Port backend / API    (default 3500, customizable)
#   -> open http://<host>:<frontend-port>
#
# Domain + automatic HTTPS (bundled reverse proxy) is opt-in via flags:
#   sudo ./deploy.sh --frontend-domain sf.raf.my.id --backend-domain api.sf.raf.my.id --tls
#   sudo ./deploy.sh --frontend-domain sf.raf.my.id --tls    # single origin, API under /api
#
# Other flags: --ip, --backend-port, --frontend-port, --no-tls, --yes (skip prompts,
#   reuse saved .env). --host/--proxy kept for compatibility.
# Re-run any time to update — config + secrets are kept in .env.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

getenv() { if [ -f .env ]; then grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true; fi; }
is_ip()  { echo "$1" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

# ---- load current values from .env (used as defaults; reused on re-run) ----
SERVER_IP="${SERVER_IP:-$(getenv SERVER_IP)}"
FRONTEND_DOMAIN="${FRONTEND_DOMAIN:-$(getenv FRONTEND_DOMAIN)}"
BACKEND_DOMAIN="${BACKEND_DOMAIN:-$(getenv BACKEND_DOMAIN)}"
BACKEND_PORT="${BACKEND_PORT:-$(getenv BACKEND_PORT)}"
FRONTEND_PORT="${FRONTEND_PORT:-$(getenv FRONTEND_PORT)}"
HTTP_PORT="${HTTP_PORT:-$(getenv HTTP_PORT)}"
HTTPS_PORT="${HTTPS_PORT:-$(getenv HTTPS_PORT)}"
TLS="${TLS:-$(getenv DEPLOY_TLS)}"
ASSUME_YES=0
FORCE_PROXY=0
DOMAIN_VIA_FLAG=0
HOST_FLAG=""

# ---- flags ----
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) SERVER_IP="$2"; shift 2 ;;
    --frontend-domain|--web-domain) FRONTEND_DOMAIN="$2"; DOMAIN_VIA_FLAG=1; shift 2 ;;
    --backend-domain|--api-domain) BACKEND_DOMAIN="$2"; DOMAIN_VIA_FLAG=1; shift 2 ;;
    --host) HOST_FLAG="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; FORCE_PROXY=1; shift 2 ;;
    --proxy) FORCE_PROXY=1; shift ;;
    --tls) TLS=1; shift ;;
    --no-tls) TLS=0; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# legacy --host: IP -> server ip, domain -> frontend domain
if [ -n "$HOST_FLAG" ]; then
  if is_ip "$HOST_FLAG"; then SERVER_IP="${SERVER_IP:-$HOST_FLAG}"; else FRONTEND_DOMAIN="$HOST_FLAG"; DOMAIN_VIA_FLAG=1; fi
fi

# ---- interactive: host + BOTH ports, asked on EVERY run (defaults pre-filled),
# so the ports are always customizable. Domain + HTTPS is opt-in via flags. ----
if [ "$ASSUME_YES" != "1" ] && [ -t 0 ] && [ "$DOMAIN_VIA_FLAG" != "1" ] && [ "$FORCE_PROXY" != "1" ]; then
  echo "──────────── Instalasi MikroTik NOC ────────────"
  DEFAULT_HOST="${SERVER_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"; DEFAULT_HOST="${DEFAULT_HOST:-localhost}"
  read -rp "Alamat akses (IP atau domain) [${DEFAULT_HOST}]: " A; SERVER_IP="${A:-$DEFAULT_HOST}"
  read -rp "Port frontend / web  [${FRONTEND_PORT:-3600}]: " A; FRONTEND_PORT="${A:-${FRONTEND_PORT:-3600}}"
  read -rp "Port backend / API   [${BACKEND_PORT:-3500}]: " A; BACKEND_PORT="${A:-${BACKEND_PORT:-3500}}"
  FRONTEND_DOMAIN=""; BACKEND_DOMAIN=""   # simple/interactive = direct ports
  echo "(domain + HTTPS otomatis: pakai flag — lihat ./deploy.sh --help)"
  echo "────────────────────────────────────────────────"
fi

# ---- final defaults ----
SERVER_IP="${SERVER_IP:-localhost}"
TLS="${TLS:-0}"
BACKEND_PORT="${BACKEND_PORT:-3500}"
FRONTEND_PORT="${FRONTEND_PORT:-3600}"
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"

# ---- derive mode, URLs, and (for proxy) the Caddyfile ----
CADDYFILE="./Caddyfile"
CADDY_SITE_ADDRESS=":80"
if [ -n "$FRONTEND_DOMAIN" ] || [ "$FORCE_PROXY" = "1" ]; then
  MODE="proxy"; APP_BIND="127.0.0.1:"; COMPOSE_PROFILE="--profile proxy"
  if [ "$TLS" = "1" ] && [ -n "$FRONTEND_DOMAIN" ]; then SC="https"; WSC="wss"; else SC="http"; WSC="ws"; TLS=0; fi

  if [ -z "$FRONTEND_DOMAIN" ]; then
    # --proxy with just an IP: single origin on HTTP_PORT
    SFX=""; [ "$HTTP_PORT" != "80" ] && SFX=":${HTTP_PORT}"
    FRONT_SITE=":${HTTP_PORT}"
    WEB_URL="http://${SERVER_IP}${SFX}"; API_URL="$WEB_URL"; WS_URL="ws://${SERVER_IP}${SFX}/ws"
    LAYOUT="single"
  else
    [ "$TLS" = "1" ] && { FRONT_SITE="$FRONTEND_DOMAIN"; BACK_SITE="$BACKEND_DOMAIN"; } || { FRONT_SITE="http://${FRONTEND_DOMAIN}"; BACK_SITE="http://${BACKEND_DOMAIN}"; }
    WEB_URL="${SC}://${FRONTEND_DOMAIN}"
    if [ -n "$BACKEND_DOMAIN" ]; then
      LAYOUT="split"; API_URL="${SC}://${BACKEND_DOMAIN}"; WS_URL="${WSC}://${BACKEND_DOMAIN}/ws"
    else
      LAYOUT="single"; API_URL="${SC}://${FRONTEND_DOMAIN}"; WS_URL="${WSC}://${FRONTEND_DOMAIN}/ws"
    fi
  fi

  mkdir -p .caddy
  if [ "$LAYOUT" = "split" ]; then
    cat > .caddy/Caddyfile <<CADDY
${FRONT_SITE} {
	encode gzip
	reverse_proxy frontend:3000
}
${BACK_SITE} {
	encode gzip
	reverse_proxy backend:4000
}
CADDY
  else
    cat > .caddy/Caddyfile <<CADDY
${FRONT_SITE} {
	encode gzip
	handle /api/* { reverse_proxy backend:4000 }
	handle /ws* { reverse_proxy backend:4000 }
	handle /uploads/* { reverse_proxy backend:4000 }
	handle { reverse_proxy frontend:3000 }
}
CADDY
  fi
  CADDYFILE="./.caddy/Caddyfile"
else
  MODE="direct"; APP_BIND=""; COMPOSE_PROFILE=""; LAYOUT="direct"
  WEB_URL="http://${SERVER_IP}:${FRONTEND_PORT}"
  API_URL="http://${SERVER_IP}:${BACKEND_PORT}"
  WS_URL="ws://${SERVER_IP}:${BACKEND_PORT}/ws"
fi

echo "==> mode=$MODE/$LAYOUT  web=$WEB_URL  api=$API_URL"

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

# ---- Deployment (set by deploy.sh) ----
DEPLOY_MODE=${MODE}
DEPLOY_LAYOUT=${LAYOUT}
DEPLOY_TLS=${TLS}
SERVER_IP=${SERVER_IP}
FRONTEND_DOMAIN=${FRONTEND_DOMAIN}
BACKEND_DOMAIN=${BACKEND_DOMAIN}
BACKEND_PORT=${BACKEND_PORT}
FRONTEND_PORT=${FRONTEND_PORT}
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}
APP_BIND=${APP_BIND}
CADDYFILE=${CADDYFILE}
CADDY_SITE_ADDRESS=${CADDY_SITE_ADDRESS}
PUBLIC_BASE_URL=${API_URL}
# CORS whitelist = the frontend origin(s) allowed to call the backend.
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

if [ "$MODE" = "proxy" ]; then
  [ "$TLS" = "1" ] && PORTS_NOTE="80 and 443" || PORTS_NOTE="${HTTP_PORT}"
else
  PORTS_NOTE="${FRONTEND_PORT} and ${BACKEND_PORT}"
fi

cat <<EOF

============================================================
 MikroTik NOC deployed  (mode: ${MODE}/${LAYOUT}$([ "$TLS" = "1" ] && echo " + TLS"))
   Open     : ${WEB_URL}
   Backend  : ${API_URL}
   Login    : ${SUPER_ADMIN_EMAIL} / ${SUPER_ADMIN_PASSWORD}

 Migrations + seed run automatically on the backend container.
 Open the firewall for port(s): ${PORTS_NOTE}
$([ -n "$FRONTEND_DOMAIN" ] && echo " Point DNS: ${FRONTEND_DOMAIN}$([ -n "$BACKEND_DOMAIN" ] && echo " + ${BACKEND_DOMAIN}") -> ${SERVER_IP}")
$([ "$TLS" = "1" ] && echo " HTTPS needs those domains public + ports 80/443 reachable for Let's Encrypt.")
 Logs:   docker compose ${COMPOSE_PROFILE} logs -f
 Stop:   docker compose ${COMPOSE_PROFILE} down
 Update: git pull && sudo ./deploy.sh        # re-uses your saved .env config
============================================================
EOF
