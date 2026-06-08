#!/usr/bin/env bash
# Локальная разработка: postgres + backend + frontend
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Создан .env из .env.example"
fi

chmod +x db/init-users.sh 2>/dev/null || true

exec bash "$(dirname "$0")/compose-up.sh" dev --build "$@"

echo ""
echo "Локально:"
echo "  UI:  http://localhost:5173"
echo "  API: http://localhost:8000/api/health"
