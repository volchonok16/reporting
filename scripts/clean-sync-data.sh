#!/bin/bash
# Удаляет синхронизированные ЗНИ/ошибки и историю sync_run для полной перезагрузки из TFS.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_USER="${POSTGRES_USER:-reporting}"
DB_NAME="${POSTGRES_DB:-reporting}"

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" base

echo "Очистка task и sync_run (пользователь: $DB_USER)…"
"${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" <<'SQL'
DELETE FROM task WHERE parent_task_id IS NOT NULL;
DELETE FROM task;
DELETE FROM sync_run;
SQL
echo "Готово. Нажмите «Обновить из TFS» в дашборде для новой загрузки."
