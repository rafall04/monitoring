#!/usr/bin/env bash
# =============================================================================
# MikroTik NOC — one-shot deploy for Ubuntu 20.04+ (Docker based).
#
#   sudo ./deploy.sh                               # localhost, ports 4000/3000
#   sudo ./deploy.sh --host 203.0.113.10           # set the public IP/domain
#   sudo BACKEND_PORT=5000 FRONTEND_PORT=8080 ./deploy.sh --host noc.example.com
#   sudo ./deploy.sh --backend-port 5000 --frontend-port 8080 --host 1.2.3.4
#
# Re-run any time to update (rebuild + restart). Secrets are generated ONCE and
# preserved across runs (kept in .env). To change ports/host later, re-run with
# new flags — the frontend is rebuilt with the new backend URL.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

getenv() { if [ -f .env ]; then grep -E "^$1=" .env | head -n1 | cut -d= -f2- || true; fi; }

# ---- config: flags > env > existing .env > default ----
PUBLIC_HOST="${PUBLIC_HOST:-$(getenv PUBLIC_HOST)}"
BACKEND_PORT="${BACKEND_PORT:-$(getenv BACKEND_PORT)}"
FRONTEND_PORT="${FRONTEND_PORT:-$(getenv FRONTEND_PORT)}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) PUBLIC_HOST="$2"; shift 2 ;;
    --backend-port) BACKEND_PORT="$2"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

PUBLIC_HOST="${PUBLIC_HOST:-localhost}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

echo "==> host=$PUBLIC_HOST  backend(host port)=$BACKEND_PORT  frontend(host port)=$FRONTEND_PORT"

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
POSTGRES_USER="$(getenv POSTGRES_USER)";              POSTGRES_USER="${POSTGRES_USER:-noc}"
POSTGRES_DB="$(getenv POSTGRES_DB)";                  POSTGRES_DB="${POSTGRES_DB:-noc}"
POSTGRES_PASSWORD="$(getenv POSTGRES_PASSWORD)";      POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 16)}"
JWT_ACCESS_SECRET="$(getenv JWT_ACCESS_SECRET)";      JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-$(openssl rand -base64 48)}"
JWT_REFRESH_SECRET="$(getenv JWT_REFRESH_SECRET)";    JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-$(openssl rand -base64 48)}"
CREDENTIALS_ENC_KEY="$(getenv CREDENTIALS_ENC_KEY)";  CREDENTIALS_ENC_KEY="${CREDENTIALS_ENC_KEY:-$(openssl rand -base64 32)}"
SUPER_ADMIN_EMAIL="$(getenv SUPER_ADMIN_EMAIL)";      SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL:-admin@noc.local}"
SUPER_ADMIN_PASSWORD="$(getenv SUPER_ADMIN_PASSWORD)"; SUPER_ADMIN_PASSWORD="${SUPER_ADMIN_PASSWORD:-ChangeMe123!}"
SUPER_ADMIN_NAME="$(getenv SUPER_ADMIN_NAME)";        SUPER_ADMIN_NAME="${SUPER_ADMIN_NAME:-Super Admin}"

API_URL="http://${PUBLIC_HOST}:${BACKEND_PORT}"
WS_URL="ws://${PUBLIC_HOST}:${BACKEND_PORT}/ws"
WEB_URL="http://${PUBLIC_HOST}:${FRONTEND_PORT}"

# ---- write .env (idempotent: secrets above are reused) ----
cat > .env <<EOF
NODE_ENV=production
LOG_LEVEL=info

# ---- Public host + ports (published ON THE HOST; containers stay on 4000/3000) ----
PUBLIC_HOST=${PUBLIC_HOST}
BACKEND_PORT=${BACKEND_PORT}
FRONTEND_PORT=${FRONTEND_PORT}
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
$SUDO docker compose up -d --build

cat <<EOF

============================================================
 MikroTik NOC deployed.
   Frontend : ${WEB_URL}
   Backend  : ${API_URL}
   Login    : ${SUPER_ADMIN_EMAIL} / ${SUPER_ADMIN_PASSWORD}

 Migrations + seed run automatically on the backend container.
 Open the firewall for ports ${FRONTEND_PORT} and ${BACKEND_PORT} if remote.
 Logs:   docker compose logs -f
 Stop:   docker compose down
 Update: git pull && sudo ./deploy.sh
============================================================
EOF
