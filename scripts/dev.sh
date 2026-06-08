#!/usr/bin/env bash
# Локальная разработка: postgres + backend + frontend
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Создан .env из .env.example"
fi

chmod +x db/init-users.sh 2>/dev/null || true

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" dev
"${COMPOSE[@]}" up --build -d "$@"

echo ""
echo "Локально:"
echo "  UI:  http://localhost:5173"
echo "  API: http://localhost:8000/api/health"
