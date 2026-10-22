#!/usr/bin/env bash
# Orchestration test: real temporary TLS files, fake Docker, no deployment.
set -Eeuo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/docker/certs" "$sandbox/bin"
cp "$root/setup.sh" "$root/Dockerfile" "$root/docker-compose.yml" \
  "$root/pnpm-lock.yaml" "$root/pnpm-workspace.yaml" "$root/package.json" \
  "$root/.env.example" "$sandbox/"
cp "$root/docker/nginx.conf.template" "$sandbox/docker/"
cat > "$sandbox/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -e
printf '%s\n' "$*" >> "$MOCK_STATE_DIR/commands"
case "$*" in
  *"account --check")
    if [[ -f "$MOCK_STATE_DIR/account" ]]; then echo present; else echo empty; fi ;;
  *"run -T --rm --no-deps account"*)
    cat >/dev/null
    touch "$MOCK_STATE_DIR/account"
    echo "Account saved." ;;
  *"pg_dump"*) echo "mock backup" ;;
esac
MOCK
chmod +x "$sandbox/bin/docker"
export PATH="$sandbox/bin:$PATH" MOCK_STATE_DIR="$sandbox"
openssl req -x509 -newkey rsa:2048 -nodes -days 3 \
  -subj /CN=puller.test -addext subjectAltName=DNS:puller.test \
  -keyout "$sandbox/docker/certs/privkey.pem" \
  -out "$sandbox/docker/certs/fullchain.pem" >/dev/null 2>&1
cd "$sandbox"
printf 'puller.test\noperator@puller.test\nFixture-password-123\nFixture-password-123\n' | bash setup.sh > first.log
test -f account
test -s .env
test "$(stat -c '%a' .env)" = 600
test -n "$(find backups -name '*.dump' -print -quit)"
! grep -q 'Fixture-password' commands
cp .env env-before
bash setup.sh </dev/null > second.log
cmp .env env-before
grep -q 'no passwords changed' second.log
rm docker/certs/fullchain.pem
if bash setup.sh </dev/null > missing-cert.log 2>&1; then
  echo 'Expected missing-certificate failure' >&2; exit 1
fi
grep -q 'Supply real' missing-cert.log
echo 'setup.sh: initial provisioning, idempotent rerun, secret-safe arguments, and missing-certificate checks passed.'
