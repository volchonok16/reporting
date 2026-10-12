#!/usr/bin/env bash
set -euo pipefail
cd /Users/ivan/Desktop/reporting
export DOCKER_HOST="${DOCKER_HOST:-unix:///Users/ivan/.docker/run/docker.sock}"

echo "=== Rebuild containers (dev) ==="
if ! docker info >/dev/null 2>&1; then
  echo "Запустите Docker Desktop и повторите."
  read -r -p "Press Enter..."
  exit 1
fi

if docker volume inspect reporting_frontend_src >/dev/null 2>&1 && [[ -f docker-compose.dev.eio.yml ]]; then
  docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.dev.eio.yml up -d --build
  # sync sources into named volume
  bash scripts/apply-frontend-local.sh || true
else
  bash scripts/compose-up.sh dev --build -d
fi

echo ""
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | head -30
echo ""
curl -s -o /dev/null -w "UI  http://localhost:5173 → %{http_code}\n" http://localhost:5173/ || true
curl -s -o /dev/null -w "API http://localhost:8000/api/health → %{http_code}\n" http://localhost:8000/api/health || true
echo DONE
read -r -p "Press Enter to close..."
