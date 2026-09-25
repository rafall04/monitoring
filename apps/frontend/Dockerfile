# Next.js frontend. Build context = repo root.
# NEXT_PUBLIC_* are inlined at build time, so they are passed as build args.
FROM node:20-alpine

WORKDIR /app

# ---- dependency layer --------------------------------------------------------
# Manifests + lockfile first so `npm ci` is only re-run when deps change.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
# Minimal stubs so npm workspaces resolves every declared workspace.
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/worker/package.json ./apps/worker/package.json
# Schema up-front so the @prisma/client postinstall can find it.
COPY packages/server/prisma ./packages/server/prisma

RUN npm ci

# ---- source layer ------------------------------------------------------------
COPY packages ./packages
COPY apps/frontend ./apps/frontend

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
ARG NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws
ARG NEXT_PUBLIC_BACKEND_PORT=4000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_BACKEND_PORT=$NEXT_PUBLIC_BACKEND_PORT
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run -w @noc/frontend build

# `next start` writes runtime caches (fetch/image) under .next/cache — keep it
# writable for the unprivileged runtime user.
RUN mkdir -p /app/apps/frontend/.next/cache && \
  chown -R node:node /app/apps/frontend/.next/cache

ENV NODE_ENV=production
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/login || exit 1

CMD ["npm", "run", "-w", "@noc/frontend", "start"]
