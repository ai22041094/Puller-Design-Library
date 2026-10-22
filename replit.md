# Puller Design Library

An enterprise catalogue for R&D and Sales teams to find, compare, and manage multi-vendor puller designs, suppliers, customers, and design history.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- App-managed email/password accounts protect private drawings. Production setup is documented in README-DOCKER.md.

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
- `artifacts/api-server/src/routes/storage.ts` — authenticated presigned uploads and private file reads.
- `lib/db/src/schema/auth.ts` — users, password credentials, and persistent sessions.
- `lib/api-spec/openapi.yaml` — API contract source of truth.
- `lib/db/src/schema/puller-library.ts` — relational schema for vendors, customers, pullers, and immutable design versions.
- `artifacts/puller-library/public/seed-images` — supplied reference images used by the starter catalogue.

## Architecture decisions

- The web app calls the shared Express API through generated React Query hooks.
- PostgreSQL stores normalized vendor/customer/puller/version relationships; image URLs are metadata, not database blobs.
- Password sessions protect catalogue and private media endpoints. Uploaded drawings/models live in a private filesystem volume; the database stores object paths and file names. Production has no Replit npm/runtime dependencies.
- Puller records store configurable dimensions in mm, cm, or inches and support 2D image/PDF and 3D GLB/STL previews.
- Design versions are append-only and receive their version number on the server.
- The initial catalogue includes sample records and the supplied reference images so the app is useful on first load.

## Product

- Dashboard with design status metrics and vendor coverage.
- Searchable, filterable catalogue with puller technical detail pages.
- Vendor and customer directory with create flows.
- Side-by-side comparison of puller designs.
- Version history and new version creation without overwriting earlier records.
- Per-puller 2D/3D media, dimensional configuration, and interactive 3D model preview.
- Sign-in gate for the library and private uploads.

## User preferences

- Production must be standalone: app-managed email/password accounts, persistent server-volume uploads, Nginx HTTPS with supplied certificate files, and no Replit packages or runtime services.
- Keep development/preview services out of the production Compose stack. Use setup.sh for server deployment.

## Gotchas

- Accounts are provisioned only by the server operator through setup.sh; all provisioned accounts share library access. There is no public signup. Existing cloud files must be exported/copied before standalone deployment.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
