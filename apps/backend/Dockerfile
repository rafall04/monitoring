# Backend API (Fastify + WebSocket). Build context = repo root.
FROM node:20-alpine

WORKDIR /app

# Install all workspace dependencies (tsx + prisma live at the root).
COPY package.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend
# Minimal stubs so npm workspaces resolves every declared workspace.
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json

RUN npm install

# Generate the Prisma client into node_modules.
RUN npm run -w @noc/server db:generate

ENV NODE_ENV=production
EXPOSE 4000

# Lightweight container healthcheck against the /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

CMD ["npm", "run", "-w", "@noc/backend", "start"]
