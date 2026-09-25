# Backend API (Fastify + WebSocket). Build context = repo root.
FROM node:20-alpine

WORKDIR /app

# Prisma's engines need OpenSSL; Alpine doesn't ship it by default (without this
# `prisma migrate deploy` fails with "Could not parse schema engine response").
# `git` is required because a wabot dep (libsignal) resolves to a git URL and the
# root npm install resolves the whole workspace graph.
# tzdata: named timezones for the uplink work-hours alert window (the container
# clock is UTC; TZ=Asia/Jakarta makes "jam kerja" mean WIB).
RUN apk add --no-cache openssl git tzdata

# ---- dependency layer --------------------------------------------------------
# Manifests + lockfile first so `npm ci` is only re-run when deps change.
# All workspace package.json files are needed: npm ci resolves the @noc/*
# workspaces via the root `workspaces` field and validates the lockfile.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY apps/backend/package.json ./apps/backend/package.json
# Minimal stubs so npm workspaces resolves every declared workspace.
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/wabot/package.json ./apps/wabot/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
# Schema up-front so the @prisma/client postinstall can find it.
COPY packages/server/prisma ./packages/server/prisma

RUN npm ci

# ---- source layer ------------------------------------------------------------
COPY packages ./packages
COPY apps/backend ./apps/backend

# Generate the Prisma client into node_modules.
RUN npm run -w @noc/server db:generate

# /app/uploads is the compose volume mount (UPLOAD_DIR=/app/uploads) — create it
# owned by `node` so the fresh named volume inherits writable permissions.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

ENV NODE_ENV=production
EXPOSE 4000
USER node

# Lightweight container healthcheck against the /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

CMD ["npm", "run", "-w", "@noc/backend", "start"]
