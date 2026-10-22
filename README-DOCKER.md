# Standalone production deployment

This app runs on your own **x86-64 Linux** server. Production contains only:

- Nginx serving built React/Vite assets and terminating HTTPS.
- Node.js 24 / Express API, running as a non-root user.
- PostgreSQL 16 with a named persistent volume.
- A separate persistent volume for private 2D/3D uploads.

No Replit account, OIDC provider, storage sidecar, connector, or Replit npm
package is required. No Vite/dev server or mockup sandbox is run in production.
The repository keeps workspace preview metadata for editing, but it is excluded
from Docker images. Native build overrides currently target Linux x86-64; ARM
hosts require a separate dependency review.

## 1. Server prerequisites

Install Docker Engine and the Docker Compose v2 plugin using the instructions
for your distribution: <https://docs.docker.com/engine/install/>.
Use a Compose version supporting `up --wait` (2.20+ recommended).
You also need Bash, OpenSSL, standard Unix tools, and permission to use Docker:

```sh
docker --version
docker compose version
docker info
openssl version
```

Point your domain's DNS at the server. Allow inbound ports **80 and 443** by
default, or the custom `HTTP_PORT` and `HTTPS_PORT` configured in `.env`.
Do not publicly expose PostgreSQL or the API. Node, pnpm, npm, and Yarn do not
need to be installed on the server; builds run inside Docker.

Copy/clone this repository to a persistent directory on the server.

## 2. Supply your TLS certificate

Place real certificate files here:

```text
docker/certs/fullchain.pem   # leaf certificate followed by intermediates
docker/certs/privkey.pem     # matching unencrypted private key
```

The supplied `.pem.example` files are **text placeholders, not usable keys or
certificates**. Obtain a trusted certificate using your CA or host ACME tooling.
Keep the private key secret:

```sh
chmod 600 docker/certs/privkey.pem
```

Certificates are mounted read-only at runtime; they are not copied into images.
Nginx redirects HTTP to HTTPS and serves TLS 1.2/1.3. Arrange certificate renewal
on the host; automatic issuance/renewal is not included. After replacing renewed
files, run `docker compose restart web`.

## 3. One-command setup

```sh
bash setup.sh
```

The script:

1. Checks required files, Docker/Compose, architecture, and conflicting lockfiles.
2. Prompts for the domain and creates a private `.env` if none exists, generating
   a random database password.
3. Validates the configured origin, certificate hostname, expiry, and matching key.
4. Builds production and one-shot maintenance images with a frozen pnpm lockfile.
5. Starts PostgreSQL and saves a database backup under `backups/`.
6. Applies the current Drizzle schema, without forcing destructive changes.
7. Prompts for the first approved account if no password accounts exist.
8. Starts the API and Nginx, waiting for container health checks.

It does **not** delete volumes, reset existing passwords, install software on
the host, open firewall ports, or issue certificates. If schema application
requires manual approval, it stops rather than forcing the change. Review the
diff and backup before applying it interactively with the maintenance service.

Re-run the same command after updating the repository. Existing `.env`, accounts,
database records, and uploaded files are retained. Keep the generated `.env`
unchanged unless intentionally changing database credentials.

### Manual equivalent

Copy `.env.example` to `.env`, replace the placeholders, supply TLS files, then:

```sh
docker compose --profile tools build api web migrate account
docker compose up -d --wait db
docker compose --profile tools run -T --rm migrate
# Provision an account using bash setup.sh account, as described below.
docker compose up -d --build
```

The `migrate` and `account` services are one-shot tools, not development servers.
Normal `docker compose up -d --build` starts only db, api, and web. Initial schema
creation and account provisioning must happen before the app is usable.

## Configuration

Only `.env.example` is committed. Real `.env` files, PEM files, uploads, backups,
Git history, host dependencies, and generated output are excluded from builds.

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Public hostname, without scheme, port, or path. |
| `HTTP_PORT` | Published Nginx HTTP port. Defaults to `80`. |
| `HTTPS_PORT` | Published Nginx HTTPS port. Defaults to `443`. |
| `APP_ORIGIN` | `https://DOMAIN`, adding `:HTTPS_PORT` when it is not `443`, without a trailing slash. Used for redirects and cross-origin write protection. |
| `POSTGRES_DB` / `POSTGRES_USER` | Database and role names. Use lowercase letters, digits, underscores. |
| `POSTGRES_PASSWORD` | Random URL-safe database password, at least 32 characters. The setup script generates it. |
| `LEGACY_PRIVATE_OBJECT_DIR` | Optional former bucket/private prefix, used only to recognize legacy references during import cleanup. |

Compose sets `NODE_ENV=production`, `PORT=8080`, `UPLOAD_DIR=/data`, and builds
`DATABASE_URL` from the database configuration. API and database ports are internal.
The browser always calls `/api` on the same HTTPS origin.

### Custom Nginx ports

The root `.env.example` includes sample settings. To serve HTTP on 8080 and
HTTPS on 8443, set these values in your server's `.env`:

```dotenv
DOMAIN=pullers.your-company.com
HTTP_PORT=8080
HTTPS_PORT=8443
APP_ORIGIN=https://pullers.your-company.com:8443
```

Then run `bash setup.sh`. Visit `https://pullers.your-company.com:8443`.
HTTP requests on port 8080 redirect to that HTTPS origin, including port 8443.
For HTTPS port 443, omit the port from APP_ORIGIN. Setup rejects invalid port
numbers, identical HTTP/HTTPS ports, and an origin that does not match the
configured HTTPS port. Existing `.env` files without port settings retain
80/443 defaults. Internal container ports and health checks remain unchanged.
If using the health-check command below, include your custom HTTPS port.

## Accounts and passwords

There is **no public signup**. Every provisioned account can access the shared
design library; provision only approved team members.

Create another account:

```sh
bash setup.sh account
```

Reset a forgotten password (requires server/Docker access):

```sh
bash setup.sh reset-password
```

Both commands prompt securely. Passwords are passed to the one-shot account
tool over stdin, not command arguments, environment variables, or logs. Account
creation does not overwrite an existing password; resets require the explicit
reset command. Users can also choose **Change password** in the app, supplying
their current password. Changing/resetting a password revokes all sessions.

Passwords use salted scrypt hashes; session tokens are random, stored hashed in
PostgreSQL, and delivered through HttpOnly/Secure/SameSite cookies. Sign-in and
password-change attempts are rate-limited. Passwords must contain 12–128
characters. The login page requires email + password, not an external account.
No email delivery service or email-based recovery is configured.

## Existing data and uploads

Existing user and design records are preserved. Old provider sessions are
rejected; there is no password to migrate from provider sign-in. Use
`setup.sh account` for an existing email to attach password credentials to that
record, or create new approved accounts.

Private uploads are stored under `/data/uploads/UUID`, with adjacent `.json`
metadata, on `uploads_data`. Upload grants expire in 15 minutes, are bound to
the signed-in account, and enforce the declared content type and size (50 MB
maximum). Existing `/objects/uploads/UUID` database paths remain valid after
the corresponding files are copied to the volume.

Old cloud files are **not downloaded or deleted automatically**. Before moving
real designs, export the old object bytes and copy each `uploads/UUID` object
into `/data/uploads/UUID` in the new volume. Preserve names/IDs and ownership
(UID/GID 1000 for the API). Create adjacent `UUID.json` metadata containing
`{"name":"drawing.pdf","size":123,"contentType":"application/pdf"}` using the
actual type and size. Missing metadata defaults to application/octet-stream.
Rewrite any absolute old storage URLs in design/version records to the matching
`/objects/uploads/UUID` path after verifying the copied file. Take backups first;
do not delete source objects until the new previews are verified.

For an existing PostgreSQL export, restore the source data before applying
pending schema changes. The new `password_credentials` table is additive.
Schema changes are not forced automatically on every container restart.

## Operations, backup, and restore

```sh
docker compose ps
docker compose logs -f api web
curl -f https://YOUR_DOMAIN/api/healthz
docker compose restart web            # reload renewed certificates
docker compose down                   # stop containers, KEEP both volumes
```

Database backup (expands variables inside the container, not the host shell):

```sh
mkdir -p backups
docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/database.dump
```

Upload-volume backup, using the API container's existing `/data` mount:

```sh
docker compose exec -T api tar -C /data -czf - . > backups/uploads.tar.gz
```

For a consistent snapshot, pause uploads while taking database and upload
backups. Copy backups and `.env` securely off-server; a persistent Docker volume
is not a backup. The setup script backs up the database only, not the uploads
volume. Set backup retention and disk-space monitoring on the host.

Restore database into an empty/backed-up target:

```sh
docker compose up -d --wait db
docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < backups/database.dump
```

`--clean` drops/replaces matching target database objects. Never use it on
valuable unbacked-up data. To restore uploads, stop API writes, extract the
archive into the `uploads_data` volume using a temporary maintenance container,
and restore UID/GID 1000 ownership before starting the API.

**Destructive:** `docker compose down --volumes` deletes both the database and
all uploaded files. Do not run it for normal updates or shutdown.

## Troubleshooting and verification

- Missing/invalid TLS files: supply real fullchain/key files; placeholders cannot
  start HTTPS. Check expiry, hostname, chain, and key match.
- Build/install errors: use only pnpm 10.26.1 and `pnpm-lock.yaml`. The Docker
  build uses `--frozen-lockfile` and rejects inconsistent manifests. Regenerate
  the lockfile with pnpm after intentional dependency changes. Do not add a
  Yarn/npm lockfile or copy host node_modules into the image.
- Database errors: inspect `docker compose logs db api`. Changing POSTGRES_PASSWORD
  after the database volume exists does not rotate the existing PostgreSQL role
  password; perform a planned database password rotation instead.
- Login fails: provision an account, use HTTPS, and check APP_ORIGIN. Existing
  external-provider passwords do not exist in this app.
- Upload fails: inspect API logs, free disk space, and volume ownership. Never
  make `/data` a public Nginx directory.
- ARM build errors: current workspace native-package overrides target x86-64.

Workspace verification can build images and validate Compose, but some embedded
Docker runners reject container exec/health-check processes with OCI setns errors.
Do not remove production health checks because of that runner limitation; run
the full stack check on a normal Linux Docker host before moving production data.
