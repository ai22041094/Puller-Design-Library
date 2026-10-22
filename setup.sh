#!/usr/bin/env bash
# Run on your own production Linux server, not in the development workspace.
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
trap 'echo "Setup stopped at line $LINENO. Existing volumes have NOT been deleted." >&2' ERR

die() { echo "ERROR: $*" >&2; exit 1; }
compose() { docker compose --env-file .env --profile tools "$@"; }
config() { awk -v key="$1" 'index($0,key"=")==1 {sub(/^[^=]*=/,""); print; exit}' .env; }
need() { command -v "$1" >/dev/null || die "Install $1 before continuing. See README-DOCKER.md."; }
need docker
need openssl
docker compose version >/dev/null
docker info >/dev/null
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die "This lockfile currently targets x86-64 Linux."

for file in Dockerfile docker-compose.yml pnpm-lock.yaml pnpm-workspace.yaml package.json .env.example docker/nginx.conf.template; do
  [[ -s "$file" ]] || die "Missing required file: $file"
done
for lock in yarn.lock package-lock.json npm-shrinkwrap.json; do
  [[ ! -e "$lock" ]] || die "Conflicting $lock found. This project uses pnpm-lock.yaml; resolve the conflict first."
done

if [[ ! -f .env ]]; then
  read -r -p "Production domain (e.g. pullers.your-company.com): " domain
  [[ "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ && "$domain" == *.* && "$domain" != *example.com* ]] || die "Enter your real domain without https:// or a path."
  db_password=$(openssl rand -hex 32)
  cat > .env <<EOF
DOMAIN=$domain
HTTP_PORT=80
HTTPS_PORT=443
APP_ORIGIN=https://$domain
POSTGRES_DB=puller_library
POSTGRES_USER=puller
POSTGRES_PASSWORD=$db_password
LEGACY_PRIVATE_OBJECT_DIR=
EOF
  unset db_password
  echo "Created private .env. Keep it backed up securely."
fi
chmod 600 .env
domain=$(config DOMAIN)
origin=$(config APP_ORIGIN)
http_port=$(config HTTP_PORT)
https_port=$(config HTTPS_PORT)
http_port=${http_port:-80}
https_port=${https_port:-443}
for port in "$http_port" "$https_port"; do
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ && "$port" -le 65535 ]] || die "HTTP_PORT and HTTPS_PORT must be integers from 1 to 65535."
done
[[ "$http_port" != "$https_port" ]] || die "HTTP_PORT and HTTPS_PORT must be different."
[[ "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ && "$domain" != *example.com* ]] || die "Set a real DOMAIN in .env."
expected_origin="https://$domain"
if [[ "$https_port" != 443 ]]; then expected_origin+=":$https_port"; fi
[[ "$origin" == "$expected_origin" ]] || die "APP_ORIGIN must be $expected_origin (without a trailing slash) to match HTTPS_PORT."
[[ "$(config POSTGRES_PASSWORD)" =~ ^[a-zA-Z0-9_-]{32,}$ && "$(config POSTGRES_PASSWORD)" != replace-* ]] || die "POSTGRES_PASSWORD must be a random URL-safe password, at least 32 characters."
for key in POSTGRES_USER POSTGRES_DB; do
  [[ "$(config "$key")" =~ ^[a-z_][a-z0-9_]*$ ]] || die "$key must use lowercase letters, digits, and underscores."
done
compose config -q

account_input() {
  local email password confirmation
  read -r -p "Account email: " email
  read -r -s -p "Password (12–128 characters): " password; echo
  read -r -s -p "Confirm password: " confirmation; echo
  [[ "$password" == "$confirmation" && ${#password} -ge 12 && ${#password} -le 128 ]] || die "Passwords must match and contain 12–128 characters."
  printf '%s\n%s\n' "$email" "$password" | compose run -T --rm --no-deps account "$@"
  unset password confirmation
}

case "${1:-deploy}" in
  account) account_input; exit ;;
  reset-password)
    echo "This resets the named account and signs it out on every device."
    read -r -p "Continue? [y/N] " reply
    [[ "$reply" == y || "$reply" == Y ]] || exit 0
    account_input --reset; exit ;;
  deploy) ;;
  *) die "Usage: bash setup.sh [deploy|account|reset-password]" ;;
esac

cert=docker/certs/fullchain.pem
key=docker/certs/privkey.pem
[[ -s "$cert" && -s "$key" ]] || die "Supply real $cert and $key. The .example files are not certificates."
openssl x509 -in "$cert" -checkend 86400 -noout >/dev/null || die "Certificate is invalid or expires within 24 hours."
openssl x509 -in "$cert" -checkhost "$domain" -noout | grep -q 'does match certificate' || die "Certificate does not cover DOMAIN."
cert_pub=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256)
key_pub=$(openssl pkey -in "$key" -passin pass: -pubout -outform DER | openssl dgst -sha256)
[[ "$cert_pub" == "$key_pub" ]] || die "Certificate and private key do not match."
chmod 600 "$key"

echo "Building production images with the frozen pnpm lockfile..."
compose build api web migrate account
compose up -d --wait --wait-timeout 120 db
mkdir -p backups
backup="backups/database-$(date -u +%Y%m%dT%H%M%SZ).dump"
compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup.tmp"
mv "$backup.tmp" "$backup"
echo "Database backup saved in $backup. Applying schema (never forced)..."
compose run -T --rm --no-deps migrate
account_state=$(compose run -T --rm --no-deps account --check | tail -n 1)
if [[ "$account_state" == present ]]; then
  echo "Existing password accounts found; no passwords changed."
else
  [[ "$account_state" == empty ]] || die "Could not check accounts."
  echo "Create the first approved library account."
  account_input
fi
compose up -d --wait --wait-timeout 180 api web
compose ps
echo "Production stack is running at $origin"
echo "Keep .env, database backups, and the uploads volume safe; schedule off-server backups."
