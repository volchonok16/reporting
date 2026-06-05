#!/bin/bash
# Применение миграций от владельца БД (reporting)
set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="${1:-db/migrations/002_add_team_to_task.sql}"
DB_USER="${POSTGRES_USER:-reporting}"
DB_NAME="${POSTGRES_DB:-reporting}"

if docker compose version &>/dev/null; then
  DC="docker compose"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"
else
  echo "docker-compose не найден"
  exit 1
fi

echo "Миграция: $MIGRATION (пользователь: $DB_USER)"
$DC exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" < "$MIGRATION"
echo "Готово."
