#!/bin/bash
# Применение миграций от владельца БД (reporting)
set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="${1:-db/migrations/002_add_team_to_task.sql}"
DB_USER="${POSTGRES_USER:-reporting}"
DB_NAME="${POSTGRES_DB:-reporting}"

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" base

echo "Миграция: $MIGRATION (пользователь: $DB_USER)"
"${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" < "$MIGRATION"
echo "Готово."
