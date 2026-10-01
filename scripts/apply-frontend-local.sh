#!/usr/bin/env bash
# Apply frontend B2B assets into local Docker (named volume or bind mount).
set -euo pipefail
cd "$(dirname "$0")/.."

export DOCKER_HOST="${DOCKER_HOST:-unix:///Users/ivan/.docker/run/docker.sock}"

echo "=== Docker ==="
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop..."
  docker desktop start 2>/dev/null || open -a Docker || true
  for i in $(seq 1 90); do
    if docker info >/dev/null 2>&1; then
      break
    fi
    sleep 2
    echo "waiting_$i"
  done
fi

if ! docker info >/dev/null 2>&1; then
  echo "DOCKER FAILED — откройте Docker Desktop вручную и повторите."
  exit 1
fi
echo "DOCKER_OK"

VOL=reporting_frontend_src
FRONT_NAME="$(docker ps -a --format '{{.Names}}' | grep -E 'frontend' | head -1 || true)"
echo "frontend container: ${FRONT_NAME:-none}"

sync_into_container() {
  local name="$1"
  echo "=== docker cp host frontend → ${name}:/app ==="
  docker cp "$(pwd)/frontend/src/." "${name}:/app/src/"
  docker cp "$(pwd)/frontend/public/." "${name}:/app/public/"
  docker cp "$(pwd)/frontend/index.html" "${name}:/app/index.html"
  docker cp "$(pwd)/frontend/package.json" "${name}:/app/package.json"
  docker cp "$(pwd)/frontend/package-lock.json" "${name}:/app/package-lock.json"
  docker cp "$(pwd)/frontend/tsconfig.json" "${name}:/app/tsconfig.json"
  docker cp "$(pwd)/frontend/vite.config.ts" "${name}:/app/vite.config.ts"
  docker exec "$name" sh -c 'test -f /app/src/ProductStatusB2B.tsx && grep -q bypassOfficeEditLock /app/src/ProductStatusB2B.tsx'
  echo CONTAINER_SYNC_OK
}

if docker volume inspect "$VOL" >/dev/null 2>&1; then
  echo "=== Sync named volume $VOL ==="
  docker run --rm \
    -v "${VOL}:/app" \
    -v "$(pwd)/frontend:/src:ro" \
    alpine:3.20 \
    sh -c '
      set -e
      mkdir -p /app/public/fonts /app/public/brand /app/src
      for p in src public index.html package.json package-lock.json tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts vite.config.js Dockerfile.dev; do
        if [ -e "/src/$p" ]; then
          rm -rf "/app/$p"
          cp -a "/src/$p" "/app/$p"
        fi
      done
      echo "--- brand ---"
      ls -la /app/public/brand
      echo "--- fonts ---"
      ls /app/public/fonts
      test -f /app/src/BrandLogo.tsx
      test -f /app/src/themes.css
      echo VOLUME_SYNC_OK
    ' || true
  # Docker Desktop иногда отдаёт контейнеру другой снимок volume — дублируем через docker cp.
  if [ -n "$FRONT_NAME" ]; then
    sync_into_container "$FRONT_NAME" || true
  fi
else
  echo "Named volume $VOL not found — using bind-mount ./frontend (already on disk)."
  if [ -n "$FRONT_NAME" ]; then
    sync_into_container "$FRONT_NAME" || true
  fi
fi
if [ -n "$FRONT_NAME" ]; then
  echo "=== Restart $FRONT_NAME ==="
  docker restart "$FRONT_NAME"
else
  echo "=== No frontend container — compose up (dev) ==="
  bash scripts/compose-up.sh dev -d --build || bash scripts/dev.sh -d || true
fi

sleep 4
echo "=== Status ==="
docker ps --format '{{.Names}}\t{{.Status}}' | head -30
curl -s -o /dev/null -w "UI http://localhost:5173 → HTTP %{http_code}\n" http://localhost:5173/ || true
echo DONE
