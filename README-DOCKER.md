# Docker deployment

This repository is a pnpm monorepo for the Puller Design Library. The Docker
setup builds the React/Vite frontend, runs the Express API, and provides a
PostgreSQL 16 database. Nginx serves the frontend and forwards `/api` requests
to the API container.

**Important:** The app currently uses Replit Auth and Replit App Storage.
Containers can be built and started outside Replit, but authentication and
uploaded drawings/models are not production-ready until those Replit-dependent
services are configured with compatible external replacements. See
[External services and remaining work](#external-services-and-remaining-work).

## Requirements

- An x86-64 Linux server with Docker Engine and the Docker Compose v2 plugin.
- Git (or another way to copy this repository to the server).
- A DNS name and HTTPS reverse proxy for production sign-in. The app marks
  authentication cookies as `Secure`.

The Dockerfile uses Node.js 24 and pnpm 10.26.1 to match this workspace.
The workspace currently excludes native ARM64 build packages, so ARM servers
need a separate dependency/build-platform review before deployment.

Install Docker Engine and the Compose plugin using the instructions for your
distribution at <https://docs.docker.com/engine/install/>. Confirm installation
and that your account can access the Docker daemon:

```sh
docker --version
docker compose version
docker info
```

### Project structure and commands

| Component | Technology and path | Build/start |
| --- | --- | --- |
| Frontend | React 19, Vite 7, Tailwind CSS; `artifacts/puller-library` | `PORT=19468 BASE_PATH=/ pnpm --filter @workspace/puller-library run build`; output: `dist/public`. Nginx serves this output on container port 80. |
| API | Express 5, TypeScript, esbuild; `artifacts/api-server` | `pnpm --filter @workspace/api-server run build`; start: `node --enable-source-maps artifacts/api-server/dist/index.mjs`, with `PORT=8080`. Node listens on all interfaces by default. |
| Database | PostgreSQL 16, Drizzle ORM; `lib/db` | `pnpm --filter @workspace/db run push` applies the current schema. |
| Shared code | API contract, generated clients/validators, auth/upload helpers; `lib/*` | Consumed by the frontend and API builds. |
| Design preview | `artifacts/mockup-sandbox` | Development-only; not started by Compose. |

The API stays on the internal Compose network. Only Nginx's port is published.

## Configure

From the project root on the server:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Edit `.env` and replace the database password and OIDC placeholders. Use the
generated hex value for `POSTGRES_PASSWORD`. Do not commit or share `.env`.
The `.gitignore` excludes it; `.env.example` contains placeholders only.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `POSTGRES_DB` | Database name created by the PostgreSQL container. |
| `POSTGRES_USER` | Database user created by the PostgreSQL container. |
| `POSTGRES_PASSWORD` | Database password. Compose builds the API's internal `DATABASE_URL` from these database settings. |
| `WEB_PORT` | Host port mapped to Nginx port 80; defaults to `8080`. |
| `ISSUER_URL` | OIDC issuer URL used by the existing authentication code. |
| `REPL_ID` | Existing code's OIDC client ID setting. Despite the name, a compatible provider's public PKCE client ID can be supplied here. |

`DATABASE_URL` is assembled inside Compose and points to the `db` service. Do
not set it to `localhost`; containers must use the Compose service name.

## Build, initialize, and start

Initialize the schema explicitly before the first app start:

```sh
docker compose --profile migration run -T --rm migrate
```

This runs the repository's Drizzle `push` command against the configured
database. Review and back up existing data before running it against a database
that already contains tables or records.

Then build and start the app:

```sh
docker compose up -d --build
```

The web container is exposed on `http://SERVER_IP:8080` by default (or the port
configured by `WEB_PORT`). For production, place it behind an HTTPS reverse proxy. Configure the
proxy to forward the original `Host`, `X-Forwarded-Host`, and
`X-Forwarded-Proto` headers so the authentication callback uses the public
HTTPS address.
If the HTTPS proxy runs on the same host, bind the published HTTP port to
`127.0.0.1` or restrict it with the server firewall rather than exposing both
HTTP and HTTPS publicly.

The OIDC client must allow this callback URL:

```text
https://YOUR_DOMAIN/api/callback
```

Check that the containers are healthy:

```sh
docker compose ps
curl -fsS http://127.0.0.1:8080/api/healthz
```

## Logs and operations

```sh
# Follow all service logs
docker compose logs -f

# Follow one service
docker compose logs -f api

# Restart after changing configuration
docker compose up -d

# Stop containers but keep the database volume
docker compose down

# Stop containers and DELETE the database volume and all database data
docker compose down --volumes
```

Do not use `docker compose down --volumes` unless you intend to permanently
delete the database stored in the Compose volume.

## Updates

1. Back up PostgreSQL and any external object storage.
2. Pull or copy the updated project files.
3. Rebuild and start:

   ```sh
   docker compose up -d --build
   ```

4. If the update changes the database schema, review the schema changes, back
   up the database, and run the migration command again:

   ```sh
docker compose --profile migration run -T --rm migrate
   ```

Schema changes are not applied automatically on each container start.

## Database backup and restore

Create a compressed backup:

```sh
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > puller-library-$(date +%F).dump
```

Restore into an empty database after starting the `db` service:
The following command drops/replaces matching objects in the target database;
do not run it against valuable data without a verified backup.

```sh
docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < puller-library-backup.dump
```

Treat database backups as sensitive; they contain account and design metadata.
For a Replit PostgreSQL database, export it separately from Replit and restore
it into this PostgreSQL service before applying any pending schema changes.

## Troubleshooting

- **Compose asks for `POSTGRES_PASSWORD`:** copy `.env.example` to `.env` and
  set a non-empty random password.
- **Database/API is unhealthy:** inspect `docker compose logs db api`; confirm
  the volume is writable and the database health check succeeds.
- **Frontend loads but API calls fail:** check `docker compose logs api web`
  and confirm Nginx is forwarding `/api` to the API container.
- **Sign-in returns to the login page or fails at the callback:** confirm the
  OIDC issuer, client ID, provider callback allowlist, and HTTPS forwarding
  headers. See the Replit Auth limitation below.
- **Uploads or existing drawings fail:** the current storage adapter requires
  a Replit sidecar and cannot access Replit App Storage from ordinary Docker.
  See the storage replacement notes below.

## External services and remaining work

### Authentication

The current code discovers an OIDC provider using `ISSUER_URL`, uses `REPL_ID`
as its client ID, and expects an OIDC provider with PKCE support. It was built
for Replit Auth. Running the containers does not guarantee Replit Auth will
accept a non-Replit hostname. Before production use, configure an external OIDC
provider that supports the app's public-client PKCE flow and register
`https://YOUR_DOMAIN/api/callback`. If the provider requires a client secret or
different logout behavior, update the authentication implementation and test
login, logout, session refresh, and callback handling before exposing the app.

### Uploaded files and object storage

The current storage adapter calls Replit's local sidecar at
`127.0.0.1:1106` to obtain credentials and signed upload URLs. That sidecar is
not present in Docker. `PRIVATE_OBJECT_DIR` and
`PUBLIC_OBJECT_SEARCH_PATHS` only identify Replit bucket paths; they do not
provide a portable storage backend.

Before enabling uploads in a standalone deployment, replace the adapter with a
supported external object store (for example, an S3-compatible service or
Google Cloud Storage), configure its credentials through the server's secret
manager, and migrate existing objects and their database paths. The replacement
must support the app's private reads, upload URL signing, and any public seed
assets. Do not expose private technical drawings as public files.

### Replit services and deployment assumptions

- The PostgreSQL container replaces the Replit-provisioned database. Back up
  and migrate existing data separately.
- Replit Auth and App Storage are not bundled or emulated by Compose.
- No credentials or production secrets are included in this repository.
- The database volume is persistent on the server; object files are not
  persisted by this Compose configuration because the current code has no
  standalone object-store adapter.
- The `mockup-sandbox` is a development preview service and is not included in
  the deployed web application.
