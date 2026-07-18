#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

if [ -n "${CONDUCTOR_PORT:-}" ]; then
  : "${GLINT_API_PORT:=$CONDUCTOR_PORT}"
  : "${GLINT_WEB_PORT:=$((CONDUCTOR_PORT + 1))}"
  : "${GLINT_WORKER_PORT:=$((CONDUCTOR_PORT + 2))}"
  : "${GLINT_POSTGRES_PORT:=$((CONDUCTOR_PORT + 3))}"
  : "${GLINT_MINIO_PORT:=$((CONDUCTOR_PORT + 4))}"
  : "${GLINT_MINIO_CONSOLE_PORT:=$((CONDUCTOR_PORT + 5))}"
fi

export GLINT_API_PORT="${GLINT_API_PORT:-3001}"
export GLINT_WEB_PORT="${GLINT_WEB_PORT:-3000}"
export GLINT_WORKER_PORT="${GLINT_WORKER_PORT:-3002}"
export GLINT_POSTGRES_PORT="${GLINT_POSTGRES_PORT:-5432}"
export GLINT_MINIO_PORT="${GLINT_MINIO_PORT:-9000}"
export GLINT_MINIO_CONSOLE_PORT="${GLINT_MINIO_CONSOLE_PORT:-9001}"
export GLINT_OBJECT_STORE_ACCESS_KEY_ID="local-glint"
export GLINT_OBJECT_STORE_BUCKET="glint"
export GLINT_OBJECT_STORE_ENDPOINT="http://127.0.0.1:$GLINT_MINIO_PORT"
export GLINT_OBJECT_STORE_REGION="local"
export GLINT_OBJECT_STORE_SECRET_ACCESS_KEY="local-glint-secret"
export GLINT_WEB_API_URL="http://127.0.0.1:$GLINT_API_PORT"
export POSTGRES_HOST="127.0.0.1"
export POSTGRES_PORT="$GLINT_POSTGRES_PORT"

wait_for() {
  attempts=0
  until curl --fail --silent --show-error --max-time 5 "$1" >/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 40 ]; then
      return 1
    fi
    sleep 0.25
  done
}

case "${1:-}" in
  start)
    pnpm turbo build \
      --filter=@glint/app-api \
      --filter=@glint/app-web \
      --filter=@glint/app-worker \
      --filter=@glint/app-migrate
    docker compose up -d --wait postgres minio
    docker compose run --rm minio-init
    pnpm --filter @glint/app-migrate start
    exec pnpm --recursive --parallel --stream \
      --filter @glint/app-api \
      --filter @glint/app-worker \
      --filter @glint/app-web \
      run start
    ;;
  stop)
    docker compose down
    ;;
  reset)
    docker compose down --volumes --remove-orphans
    ;;
  test)
    wait_for "http://127.0.0.1:$GLINT_API_PORT/live"
    wait_for "http://127.0.0.1:$GLINT_API_PORT/ready"
    wait_for "http://127.0.0.1:$GLINT_WORKER_PORT/live"
    wait_for "http://127.0.0.1:$GLINT_WORKER_PORT/ready"
    wait_for "http://127.0.0.1:$GLINT_WEB_PORT/live"
    wait_for "http://127.0.0.1:$GLINT_WEB_PORT/ready"
    docker compose exec -T postgres psql -U glint -d glint -v ON_ERROR_STOP=1 \
      -c "SELECT 1 / count(*) FROM pg_tables WHERE schemaname = 'drizzle' AND tablename LIKE 'glint_%_migrations';"
    printf '%s\n' 'Local stack checks passed: migration, API, worker, and web are ready.'
    ;;
  *)
    printf '%s\n' 'Usage: dev/local-stack.sh <start|stop|reset|test>' >&2
    exit 1
    ;;
esac
