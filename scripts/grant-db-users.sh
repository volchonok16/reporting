#!/usr/bin/env bash
# Выдать alex/ivan права на все таблицы и sequences (в т.ч. после новых миграций).
set -euo pipefail
cd "$(dirname "$0")/.."

DB_USER="${POSTGRES_USER:-reporting}"
DB_NAME="${POSTGRES_DB:-reporting}"

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" base

echo "==> GRANT для alex, ivan (пользователь: $DB_USER, БД: $DB_NAME)"
"${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" < db/grants-app-users.sql
echo "Готово."
