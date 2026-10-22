# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/package.json
COPY artifacts/puller-library/package.json artifacts/puller-library/package.json
COPY lib/api-client-react/package.json lib/api-client-react/package.json
COPY lib/api-spec/package.json lib/api-spec/package.json
COPY lib/api-zod/package.json lib/api-zod/package.json
COPY lib/db/package.json lib/db/package.json
COPY lib/object-storage-web/package.json lib/object-storage-web/package.json
COPY lib/replit-auth-web/package.json lib/replit-auth-web/package.json
COPY scripts/package.json scripts/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @workspace/api-server run build
RUN PORT=19468 BASE_PATH=/ NODE_ENV=production \
    pnpm --filter @workspace/puller-library run build

FROM build AS migration

CMD ["pnpm", "--filter", "@workspace/db", "run", "push"]

FROM node:24-bookworm-slim AS api

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/artifacts/api-server ./artifacts/api-server
COPY --from=build --chown=node:node /app/lib ./lib

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]

FROM nginx:alpine AS web

COPY --from=build /app/artifacts/puller-library/dist/public /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1
