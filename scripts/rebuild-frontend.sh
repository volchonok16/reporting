#!/usr/bin/env bash
# Пересборка frontend на production (обход ContainerConfig)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Удаляем все контейнеры frontend…"
docker ps -aq --filter "name=reporting-frontend" | xargs -r docker rm -f

echo "==> Сборка и запуск…"
exec bash scripts/compose-up.sh prod --build frontend
