# Monitoring worker (Netwatch poller + reconciliation). Build context = repo root.
FROM node:20-alpine

WORKDIR /app

# Prisma's query engine needs OpenSSL (Alpine doesn't ship it by default).
RUN apk add --no-cache openssl

# ---- dependency layer --------------------------------------------------------
# Manifests + lockfile first so `npm ci` is only re-run when deps change.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY apps/worker/package.json ./apps/worker/package.json
# Minimal stubs so npm workspaces resolves every declared workspace.
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
# Schema up-front so the @prisma/client postinstall can find it.
COPY packages/server/prisma ./packages/server/prisma

RUN npm ci

# ---- source layer ------------------------------------------------------------
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN npm run -w @noc/server db:generate

ENV NODE_ENV=production
EXPOSE 4100
USER node

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4100/health || exit 1

CMD ["npm", "run", "-w", "@noc/worker", "start"]
