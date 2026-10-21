# Puller Design Library

An enterprise catalogue for R&D and Sales teams to find, compare, and manage multi-vendor puller designs, suppliers, customers, and design history.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/puller-library` — React/Vite app with the dashboard, catalogue, puller detail and version history, vendor/customer directory, and comparison routes.
- `artifacts/api-server/src/routes/puller-library.ts` — API operations for summaries, vendors, customers, pullers, versions, and comparison.
- `lib/api-spec/openapi.yaml` — API contract source of truth.
- `lib/db/src/schema/puller-library.ts` — relational schema for vendors, customers, pullers, and immutable design versions.
- `artifacts/puller-library/public/seed-images` — supplied reference images used by the starter catalogue.

## Architecture decisions

- The web app calls the shared Express API through generated React Query hooks.
- PostgreSQL stores normalized vendor/customer/puller/version relationships; image URLs are metadata, not database blobs.
- Design versions are append-only and receive their version number on the server.
- The initial catalogue includes sample records and the supplied reference images so the app is useful on first load.

## Product

- Dashboard with design status metrics and vendor coverage.
- Searchable, filterable catalogue with puller technical detail pages.
- Vendor and customer directory with create flows.
- Side-by-side comparison of puller designs.
- Version history and new version creation without overwriting earlier records.

## User preferences

_No explicit preferences recorded._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
