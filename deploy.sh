#!/usr/bin/env bash
# =============================================================================
# MikroTik NOC — installer for Ubuntu 20.04+ (Docker based).
#
# Just run it and answer the prompts (asked every run; press Enter to keep the
# current value, so the ports are always customizable):
#   sudo ./deploy.sh
#     1) IP server
#     2) Domain frontend   (blank = access via IP)
#     3) Domain backend/API(blank = same domain, served under /api)
#     4) Port frontend / web   (default 3600)
#     5) Port backend / API    (default 3500)
#     6) HTTPS? (only if a domain was entered)
#
# The apps are always published on the two ports (direct access). When a domain
# is set, a bundled Caddy reverse proxy also serves it (auto-TLS with --tls), and
# CORS is whitelisted to the frontend domain + the IP:port.
#
# Flags (automation): --ip, --frontend-domain, --backend-domain, --backend-port,
#   --frontend-port, --tls/--no-tls, --yes (skip prompts, reuse .env),
#   --cloudflare  (external proxy / Cloudflare Tunnel: apps on the ports, domain
#                  URLs over HTTPS, no bundled Caddy — just forward localhost).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

getenv() { if [ -f .env ]; then grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true; fi; }
is_ip()  { echo "$1" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

# ---- load current values from .env (defaults; reused on re-run) ----
SERVER_IP="${SERVER_IP:-$(getenv SERVER_IP)}"
FRONTEND_DOMAIN="${FRONTEND_DOMAIN:-$(getenv FRONTEND_DOMAIN)}"
BACKEND_DOMAIN="${BACKEND_DOMAIN:-$(getenv BACKEND_DOMAIN)}"
BACKEND_PORT="${BACKEND_PORT:-$(getenv BACKEND_PORT)}"
FRONTEND_PORT="${FRONTEND_PORT:-$(getenv FRONTEND_PORT)}"
TLS="${TLS:-$(getenv DEPLOY_TLS)}"
EXTERNAL="${EXTERNAL:-$(getenv DEPLOY_EXTERNAL)}"
ASSUME_YES=0

# ---- flags ----
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) SERVER_IP="$2"; shift 2 ;;
    --frontend-domain|--web-domain) FRONTEND_DOMAIN="$2"; shift 2 ;;
    --backend-domain|--api-domain) BACKEND_DOMAIN="$2"; shift 2 ;;
    --host) if is_ip "$2"; then SERVER_IP="$2"; else FRONTEND_DOMAIN="$2"; fi; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
    --tls) TLS=1; shift ;;
    --no-tls) TLS=0; shift ;;
    --cloudflare|--external-proxy|--external) EXTERNAL=1; shift ;;
    --proxy) EXTERNAL=0; shift ;; # use the bundled Caddy proxy instead of an external one
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ---- interactive: 3 inputs (IP, frontend domain, backend domain) + 2 ports,
# asked on EVERY run with the current values pre-filled. ----
if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  echo "──────────── Instalasi MikroTik NOC ────────────"
  DI="${SERVER_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"; DI="${DI:-localhost}"
  read -rp "1) IP server [${DI}]: " A; SERVER_IP="${A:-$DI}"
  read -rp "2) Domain frontend (Enter=tetap, - =hapus)${FRONTEND_DOMAIN:+ [$FRONTEND_DOMAIN]}: " A; A="${A:-$FRONTEND_DOMAIN}"; [ "$A" = "-" ] && A=""; FRONTEND_DOMAIN="$A"
  read -rp "3) Domain backend/API (Enter=tetap, - =hapus)${BACKEND_DOMAIN:+ [$BACKEND_DOMAIN]}: " A; A="${A:-$BACKEND_DOMAIN}"; [ "$A" = "-" ] && A=""; BACKEND_DOMAIN="$A"
  read -rp "4) Port frontend / web  [${FRONTEND_PORT:-3600}]: " A; FRONTEND_PORT="${A:-${FRONTEND_PORT:-3600}}"
  read -rp "5) Port backend / API   [${BACKEND_PORT:-3500}]: " A; BACKEND_PORT="${A:-${BACKEND_PORT:-3500}}"
  if [ -n "$FRONTEND_DOMAIN" ]; then
    DT="T"; [ "$TLS" = "1" ] && DT="Y"
    read -rp "6) HTTPS otomatis (Let's Encrypt; domain harus publik) [y/T] (default ${DT}): " A
    case "${A:-$DT}" in [Yy]*) TLS=1 ;; *) TLS=0 ;; esac
  fi
  echo "────────────────────────────────────────────────"
fi

# ---- final defaults ----
SERVER_IP="${SERVER_IP:-localhost}"
TLS="${TLS:-0}"
EXTERNAL="${EXTERNAL:-0}"
BACKEND_PORT="${BACKEND_PORT:-3500}"
FRONTEND_PORT="${FRONTEND_PORT:-3600}"
HTTP_PORT=80
HTTPS_PORT=443
APP_BIND=""   # apps are always published on the custom host ports (direct access)

# ---- derive URLs + (when a domain is set) the bundled Caddy proxy ----
CADDYFILE="./Caddyfile"
CADDY_SITE_ADDRESS=":80"
if [ -n "$FRONTEND_DOMAIN" ] && [ "$EXTERNAL" = "1" ]; then
  # External proxy (Cloudflare Tunnel / own ingress): apps stay on the host ports,
  # public URLs use the domains over HTTPS, and NO bundled Caddy runs.
  COMPOSE_PROFILE=""; LAYOUT="external"
  WEB_URL="https://${FRONTEND_DOMAIN}"
  if [ -n "$BACKEND_DOMAIN" ]; then API_URL="https://${BACKEND_DOMAIN}"; WS_URL="wss://${BACKEND_DOMAIN}/ws"
  else API_URL="https://${FRONTEND_DOMAIN}"; WS_URL="wss://${FRONTEND_DOMAIN}/ws"; fi
  CORS_ORIGIN="${WEB_URL},http://${SERVER_IP}:${FRONTEND_PORT},http://localhost:${FRONTEND_PORT}"
elif [ -n "$FRONTEND_DOMAIN" ]; then
  COMPOSE_PROFILE="--profile proxy"
  [ "$TLS" = "1" ] && { SC="https"; WSC="wss"; } || { SC="http"; WSC="ws"; }
  WEB_URL="${SC}://${FRONTEND_DOMAIN}"
  if [ -n "$BACKEND_DOMAIN" ]; then
    LAYOUT="split"; API_URL="${SC}://${BACKEND_DOMAIN}"; WS_URL="${WSC}://${BACKEND_DOMAIN}/ws"
  else
    LAYOUT="single"; API_URL="${SC}://${FRONTEND_DOMAIN}"; WS_URL="${WSC}://${FRONTEND_DOMAIN}/ws"
  fi
  # CORS whitelist = frontend domain + direct IP:port
  CORS_ORIGIN="${WEB_URL},http://${SERVER_IP}:${FRONTEND_PORT}"

  [ "$TLS" = "1" ] && { FS="$FRONTEND_DOMAIN"; BS="$BACKEND_DOMAIN"; } || { FS="http://${FRONTEND_DOMAIN}"; BS="http://${BACKEND_DOMAIN}"; }
  mkdir -p .caddy
  if [ "$LAYOUT" = "split" ]; then
    cat > .caddy/Caddyfile <<CADDY
${FS} {
	encode gzip
	reverse_proxy frontend:3000
}
${BS} {
	encode gzip
	reverse_proxy backend:4000
}
CADDY
  else
    cat > .caddy/Caddyfile <<CADDY
${FS} {
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
  COMPOSE_PROFILE=""; LAYOUT="direct"
  WEB_URL="http://${SERVER_IP}:${FRONTEND_PORT}"
  API_URL="http://${SERVER_IP}:${BACKEND_PORT}"
  WS_URL="ws://${SERVER_IP}:${BACKEND_PORT}/ws"
  CORS_ORIGIN="${WEB_URL}"
fi

echo "==> ${LAYOUT}  web=${WEB_URL}  api=${API_URL}  (apps on host ${FRONTEND_PORT}/${BACKEND_PORT})"

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
SUPER_ADMIN_PASSWORD="$(getenv SUPER_ADMIN_PASSWORD)"; SUPER_ADMIN_PASSWORD="${SUPER_ADMIN_PASSWORD:-admin123}"
SUPER_ADMIN_NAME="$(getenv SUPER_ADMIN_NAME)";         SUPER_ADMIN_NAME="${SUPER_ADMIN_NAME:-Super Admin}"

# ---- write .env ----
cat > .env <<EOF
NODE_ENV=production
LOG_LEVEL=info

# ---- Deployment (set by deploy.sh) ----
DEPLOY_LAYOUT=${LAYOUT}
DEPLOY_TLS=${TLS}
DEPLOY_EXTERNAL=${EXTERNAL}
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
# CORS whitelist = frontend origin(s) allowed to call the backend.
CORS_ORIGIN=${CORS_ORIGIN}

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
NEXT_PUBLIC_BACKEND_PORT=${BACKEND_PORT}
EOF
echo "==> wrote .env"

# ---- build + start ----
$SUDO docker compose ${COMPOSE_PROFILE} up -d --build

PORTS_NOTE="${FRONTEND_PORT} and ${BACKEND_PORT}"
[ -n "$FRONTEND_DOMAIN" ] && { PORTS_NOTE="${PORTS_NOTE}; proxy 80"; [ "$TLS" = "1" ] && PORTS_NOTE="${PORTS_NOTE} and 443"; }

cat <<EOF

============================================================
 MikroTik NOC deployed  (${LAYOUT}$([ "$TLS" = "1" ] && echo " + TLS"))
   Open     : ${WEB_URL}
   Backend  : ${API_URL}
   Direct   : http://${SERVER_IP}:${FRONTEND_PORT} (web) · http://${SERVER_IP}:${BACKEND_PORT} (api)
   Login    : ${SUPER_ADMIN_EMAIL} / ${SUPER_ADMIN_PASSWORD}

 Migrations + seed run automatically on the backend container.
 Open the firewall for port(s): ${PORTS_NOTE}
$([ -n "$FRONTEND_DOMAIN" ] && echo " Point DNS: ${FRONTEND_DOMAIN}$([ -n "$BACKEND_DOMAIN" ] && echo " + ${BACKEND_DOMAIN}") -> ${SERVER_IP}")
 Logs:   docker compose ${COMPOSE_PROFILE} logs -f
 Stop:   docker compose ${COMPOSE_PROFILE} down
 Update: git pull && sudo ./deploy.sh --yes        # reuse saved config
============================================================
EOF
