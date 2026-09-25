# WhatsApp bot (Baileys socket + outbox consumer). Build context = repo root.
FROM node:20-alpine

WORKDIR /app

# Prisma's query engine needs OpenSSL (Alpine doesn't ship it by default).
# `git` is required because baileys → libsignal resolves to a git URL.
RUN apk add --no-cache openssl git

COPY package.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/wabot ./apps/wabot
# Minimal stubs so npm workspaces resolves every declared workspace.
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json

RUN npm install
RUN npm run -w @noc/server db:generate

ENV NODE_ENV=production
EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4200/health || exit 1

CMD ["npm", "run", "-w", "@noc/wabot", "start"]
