#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

NODE_BIN="$(command -v node || command -v node.exe || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js is required to generate temporary credentials and validate URLs." >&2
  exit 1
fi

if command -v node >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  PNPM_MODE="native"
elif command -v corepack.cmd >/dev/null 2>&1 && command -v cmd.exe >/dev/null 2>&1; then
  PNPM_MODE="windows"
else
  echo "Corepack is required to run the repository's pinned pnpm version." >&2
  exit 1
fi

RUN_ID="$(date +%s)-$$"
POSTGRES_CONTAINER="uneventful-it-postgres-$RUN_ID"
REDIS_CONTAINER="uneventful-it-redis-$RUN_ID"
OBJECT_STORAGE_CONTAINER="uneventful-it-object-storage-$RUN_ID"
INTEGRATION_RESULTS="$(mktemp)"
PLAYWRIGHT_RESULTS="$(mktemp)"
PLAYWRIGHT_ARGS=()

if [ -n "${PLAYWRIGHT_WORKERS:-}" ]; then
  if ! [[ "$PLAYWRIGHT_WORKERS" =~ ^[1-9][0-9]*$ ]]; then
    echo "PLAYWRIGHT_WORKERS must be a positive integer." >&2
    exit 1
  fi
  PLAYWRIGHT_ARGS+=(--workers="$PLAYWRIGHT_WORKERS")
fi

if [ -n "${PLAYWRIGHT_REPEAT_EACH:-}" ]; then
  if ! [[ "$PLAYWRIGHT_REPEAT_EACH" =~ ^[1-9][0-9]*$ ]]; then
    echo "PLAYWRIGHT_REPEAT_EACH must be a positive integer." >&2
    exit 1
  fi
  PLAYWRIGHT_ARGS+=(--repeat-each="$PLAYWRIGHT_REPEAT_EACH")
fi

cleanup() {
  status=$?
  trap - EXIT INT TERM
  rm -f "$INTEGRATION_RESULTS" "$PLAYWRIGHT_RESULTS"
  docker rm --force "$OBJECT_STORAGE_CONTAINER" >/dev/null 2>&1 || true
  docker rm --force "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  docker rm --force "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'status=$?; printf "Integration runner failed at line %s (exit %s).\n" "$LINENO" "$status" >&2; exit "$status"' ERR

validate_local_url() {
  local variable_name="$1"
  local value="$2"

  "$NODE_BIN" - "$variable_name" "$value" <<'NODE'
const [name, value] = process.argv.slice(2);
let parsed;

try {
  parsed = new URL(value);
} catch {
  console.error(`${name} must be a valid URL.`);
  process.exit(1);
}

const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
  console.error(`${name} must target localhost, 127.0.0.1, or ::1.`);
  process.exit(1);
}
NODE
}

run_pnpm() {
  if [ "$PNPM_MODE" = "native" ]; then
    corepack pnpm "$@"
  else
    export WSLENV="${WSLENV:+$WSLENV:}DATABASE_URL:MIGRATION_DATABASE_URL:SHADOW_DATABASE_URL:REDIS_URL:TEST_DATABASE_URL:TEST_MIGRATION_DATABASE_URL:TEST_REDIS_URL:OBJECT_STORAGE_ENDPOINT:AWS_ACCESS_KEY_ID:AWS_SECRET_ACCESS_KEY:NODE_ENV"
    cmd.exe /d /s /c "corepack pnpm $*"
  fi
}

for url_name in \
  DATABASE_URL \
  MIGRATION_DATABASE_URL \
  SHADOW_DATABASE_URL \
  REDIS_URL \
  TEST_DATABASE_URL \
  TEST_MIGRATION_DATABASE_URL \
  TEST_REDIS_URL \
  OBJECT_STORAGE_ENDPOINT
do
  if [ -n "$(printenv "$url_name" 2>/dev/null || true)" ]; then
    validate_local_url "$url_name" "$(printenv "$url_name")"
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run the local integration suite." >&2
  exit 1
fi

POSTGRES_DB="uneventful_ci"
POSTGRES_USER="uneventful_ci_bootstrap"
BOOTSTRAP_PASSWORD="$("$NODE_BIN" -p "require('node:crypto').randomBytes(24).toString('base64url')")"
MIGRATOR_PASSWORD="$("$NODE_BIN" -p "require('node:crypto').randomBytes(24).toString('base64url')")"
APP_PASSWORD="$("$NODE_BIN" -p "require('node:crypto').randomBytes(24).toString('base64url')")"
REDIS_PASSWORD="$("$NODE_BIN" -p "require('node:crypto').randomBytes(24).toString('base64url')")"
OBJECT_STORAGE_ACCESS_KEY="e2e$("$NODE_BIN" -p "require('node:crypto').randomBytes(12).toString('hex')")"
OBJECT_STORAGE_SECRET_KEY="$("$NODE_BIN" -p "require('node:crypto').randomBytes(32).toString('hex')")"

POSTGRES_IMAGE="postgres:17-alpine@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065"
REDIS_IMAGE="redis:7.4-alpine"
OBJECT_STORAGE_IMAGE="ghcr.io/versity/versitygw@sha256:dd880fd85c3faba0411da8798d3f6f0827a779d962f257f3624b1fef76d56b7b"

echo "Starting the disposable PostgreSQL 17 container..."
docker run --detach --rm \
  --name "$POSTGRES_CONTAINER" \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_DB="$POSTGRES_DB" \
  --env POSTGRES_USER="$POSTGRES_USER" \
  --env POSTGRES_PASSWORD="$BOOTSTRAP_PASSWORD" \
  --health-cmd "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB" \
  --health-interval 5s \
  --health-timeout 5s \
  --health-retries 20 \
  "$POSTGRES_IMAGE" >/dev/null

echo "Starting the disposable Redis 7 container..."
docker run --detach --rm \
  --name "$REDIS_CONTAINER" \
  --publish 127.0.0.1::6379 \
  --health-cmd "redis-cli --no-auth-warning -a $REDIS_PASSWORD ping" \
  --health-interval 5s \
  --health-timeout 5s \
  --health-retries 20 \
  "$REDIS_IMAGE" \
  redis-server --requirepass "$REDIS_PASSWORD" >/dev/null

echo "Starting the disposable S3-compatible object-storage container..."
MSYS_NO_PATHCONV=1 docker run --detach \
  --name "$OBJECT_STORAGE_CONTAINER" \
  --publish 127.0.0.1::7070 \
  --env ROOT_ACCESS_KEY="$OBJECT_STORAGE_ACCESS_KEY" \
  --env ROOT_SECRET_KEY="$OBJECT_STORAGE_SECRET_KEY" \
  "$OBJECT_STORAGE_IMAGE" \
  --port :7070 --health /health --quiet posix /tmp >/dev/null
OBJECT_STORAGE_RUNNING="$(
  docker inspect --format='{{.State.Running}}' "$OBJECT_STORAGE_CONTAINER" 2>/dev/null || true
)"
if [ "$OBJECT_STORAGE_RUNNING" != "true" ]; then
  docker logs "$OBJECT_STORAGE_CONTAINER" >&2 || true
  echo "The object-storage container exited during startup." >&2
  exit 1
fi

wait_for_healthy() {
  local container="$1"
  local description="$2"
  local attempt=0
  local health

  while [ "$attempt" -lt 60 ]; do
    health="$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    if [ "$health" = "healthy" ]; then
      return
    fi
    if [ "$health" = "unhealthy" ]; then
      echo "$description container failed its health check." >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "Timed out waiting for the $description container to become healthy." >&2
  return 1
}

wait_for_healthy "$POSTGRES_CONTAINER" "PostgreSQL"
wait_for_healthy "$REDIS_CONTAINER" "Redis"

POSTGRES_PORT="$(docker port "$POSTGRES_CONTAINER" 5432/tcp | awk -F: 'END { print $NF }')"
REDIS_PORT="$(docker port "$REDIS_CONTAINER" 6379/tcp | awk -F: 'END { print $NF }')"
OBJECT_STORAGE_PORT="$(docker port "$OBJECT_STORAGE_CONTAINER" 7070/tcp | awk -F: 'END { print $NF }')"

if [ -z "$POSTGRES_PORT" ] || [ -z "$REDIS_PORT" ] || [ -z "$OBJECT_STORAGE_PORT" ]; then
  echo "Could not determine the temporary integration-service host ports." >&2
  exit 1
fi

DATABASE_URL="postgresql://uneventful_app:$APP_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB?schema=public"
MIGRATION_DATABASE_URL="postgresql://uneventful_migrator:$MIGRATOR_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB?schema=public"
SHADOW_DATABASE_URL="postgresql://uneventful_migrator:$MIGRATOR_PASSWORD@127.0.0.1:$POSTGRES_PORT/${POSTGRES_DB}_shadow?schema=public"
TEST_DATABASE_URL="$DATABASE_URL"
TEST_MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL"
TEST_REDIS_URL="redis://:$REDIS_PASSWORD@127.0.0.1:$REDIS_PORT"
REDIS_URL="$TEST_REDIS_URL"
OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:$OBJECT_STORAGE_PORT"
AWS_ACCESS_KEY_ID="$OBJECT_STORAGE_ACCESS_KEY"
AWS_SECRET_ACCESS_KEY="$OBJECT_STORAGE_SECRET_KEY"

validate_local_url DATABASE_URL "$DATABASE_URL"
validate_local_url MIGRATION_DATABASE_URL "$MIGRATION_DATABASE_URL"
validate_local_url SHADOW_DATABASE_URL "$SHADOW_DATABASE_URL"
validate_local_url TEST_DATABASE_URL "$TEST_DATABASE_URL"
validate_local_url TEST_MIGRATION_DATABASE_URL "$TEST_MIGRATION_DATABASE_URL"
validate_local_url TEST_REDIS_URL "$TEST_REDIS_URL"
validate_local_url OBJECT_STORAGE_ENDPOINT "$OBJECT_STORAGE_ENDPOINT"

echo "Waiting for the S3-compatible object-storage endpoint..."
storage_ready=0
for ((attempt = 0; attempt < 60; attempt++)); do
  if "$NODE_BIN" - "$OBJECT_STORAGE_ENDPOINT/health" <<'NODE'
const [url] = process.argv.slice(2);
fetch(url).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1));
NODE
  then
    storage_ready=1
    break
  fi
  sleep 1
done
if [ "$storage_ready" != "1" ]; then
  echo "The object-storage endpoint did not become ready." >&2
  exit 1
fi

export DATABASE_URL MIGRATION_DATABASE_URL SHADOW_DATABASE_URL TEST_DATABASE_URL
export TEST_MIGRATION_DATABASE_URL TEST_REDIS_URL REDIS_URL
export OBJECT_STORAGE_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export NODE_ENV=test
export UNEVENTFUL_MIGRATOR_DB_PASSWORD="$MIGRATOR_PASSWORD"
export UNEVENTFUL_APP_DB_PASSWORD="$APP_PASSWORD"

docker exec -i \
  --env "UNEVENTFUL_MIGRATOR_DB_PASSWORD=$MIGRATOR_PASSWORD" \
  --env "UNEVENTFUL_APP_DB_PASSWORD=$APP_PASSWORD" \
  "$POSTGRES_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < "$REPO_ROOT/apps/api/prisma/provision-roles.sql"

echo "Applying all migrations to the disposable PostgreSQL database..."
run_pnpm --filter @uneventful/api db:deploy

echo "Verifying Prisma migrations match the schema..."
run_pnpm --filter @uneventful/api exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --exit-code

echo "Seeding the disposable database to match CI..."
run_pnpm --filter @uneventful/api db:seed

echo "Verifying database constraints and application-role privileges..."
MIGRATION_DATABASE_URL="$DATABASE_URL" \
  run_pnpm --filter @uneventful/api exec prisma db execute --file prisma/verify-constraints.sql

echo "Verifying audit-log triggers as the migration owner..."
run_pnpm --filter @uneventful/api exec prisma db execute --file prisma/verify-audit-immutability.sql

echo "Verifying the seed command refuses production..."
if seed_output="$(
  NODE_ENV=production \
    DATABASE_URL=postgresql://invalid:invalid@localhost/invalid \
    run_pnpm --filter @uneventful/api exec tsx prisma/seed.ts 2>&1
)"; then
  echo "Seed unexpectedly succeeded with NODE_ENV=production." >&2
  exit 1
fi
if ! grep -Fq "Database seeding is disabled in production." <<<"$seed_output"; then
  echo "Seed failed for a reason other than the production guard." >&2
  printf '%s\n' "$seed_output" >&2
  exit 1
fi
echo "Seed refused production as expected."

if [ "${RUN_E2E:-0}" = "1" ]; then
  echo "Verifying the Playwright test-count minimum..."
  run_pnpm --filter @uneventful/web exec playwright test --list --reporter=json \
    > "$PLAYWRIGHT_RESULTS"
  node - "$PLAYWRIGHT_RESULTS" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const count = (suites) => suites.reduce(
  (total, suite) => total + (suite.specs?.length ?? 0) + count(suite.suites ?? []),
  0
);
const testCount = count(report.suites);
const minimum = 36;
console.log(`Playwright test count: ${testCount}`);
if (testCount < minimum) {
  console.error(`The Playwright suite contains ${testCount} tests; minimum is ${minimum}.`);
  process.exit(1);
}
NODE
  echo "Running the full Playwright suite against the disposable API, PostgreSQL, and Redis..."
run_pnpm --filter @uneventful/web test:e2e "${PLAYWRIGHT_ARGS[@]}"
fi

echo "Running API PostgreSQL and Redis integration tests..."
run_pnpm --filter @uneventful/api test:integration \
--reporter=default \
--reporter=json \
"--outputFile.json=$INTEGRATION_RESULTS"
node - "$INTEGRATION_RESULTS" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const count = report.numTotalTests;
const minimum = 118;
console.log(`API integration test count: ${count}`);
if (!Number.isSafeInteger(count) || count < minimum) {
console.error(`The API integration suite ran ${count} tests; minimum is ${minimum}.`);
process.exit(1);
}
NODE

echo "Integration tests passed; disposable containers will now be removed."
