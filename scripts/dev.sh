#!/usr/bin/env bash
# Локальная разработка: postgres + backend + frontend
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Создан .env из .env.example"
fi

chmod +x db/init-users.sh 2>/dev/null || true

if docker compose version &>/dev/null; then
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d "$@"
elif command -v docker-compose &>/dev/null; then
  docker-compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d "$@"
else
  echo "Docker Compose не найден." >&2
  exit 1
fi

echo ""
echo "Локально:"
echo "  UI:  http://localhost:5173"
echo "  API: http://localhost:8000/api/health"
