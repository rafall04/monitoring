# Monitoring worker (Netwatch poller + reconciliation). Build context = repo root.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
# Minimal stubs so npm workspaces resolves every declared workspace.
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json

RUN npm install
RUN npm run -w @noc/server db:generate

ENV NODE_ENV=production
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4100/health || exit 1

CMD ["npm", "run", "-w", "@noc/worker", "start"]
