#!/usr/bin/env bash
# Применяет недостающие SQL-миграции перед стартом backend (offline/prod).
# Обходит случай, когда schema_migration отмечена, а таблицы не созданы.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_USER="${POSTGRES_USER:-reporting}"
DB_NAME="${POSTGRES_DB:-reporting}"

if [[ -z "${COMPOSE:-}" ]]; then
  # shellcheck source=resolve-compose.sh
  source "$(dirname "$0")/resolve-compose.sh" "${1:-offline}"
fi

psql_exec() {
  "${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

table_exists() {
  local name="$1"
  psql_exec -tAc \
    "SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = '${name}'
     )" | tr -d '[:space:]'
}

column_exists() {
  local table="$1"
  local column="$2"
  psql_exec -tAc \
    "SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = '${table}'
         AND column_name = '${column}'
     )" | tr -d '[:space:]'
}

wait_for_postgres() {
  echo "==> Ожидание PostgreSQL…"
  for i in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      echo "    PostgreSQL готов"
      return 0
    fi
    sleep 2
  done
  echo "Ошибка: PostgreSQL не отвечает за 120 с" >&2
  return 1
}

ensure_schema_migration_table() {
  local tracking="db/migrations/000_schema_migration.sql"
  if [[ -f "$tracking" ]]; then
    psql_exec < "$tracking"
  else
    psql_exec <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migration (
    name         VARCHAR(255) PRIMARY KEY,
    applied_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
SQL
  fi
}

mark_migration_applied() {
  local name="$1"
  psql_exec -c \
    "INSERT INTO schema_migration (name) VALUES ('${name}') ON CONFLICT (name) DO NOTHING"
}

apply_migration_file() {
  local path="$1"
  local name
  name="$(basename "$path")"
  echo "==> Миграция: ${name}"
  psql_exec < "$path"
  mark_migration_applied "$name"
}

echo "==> ensure-db-schema (БД: ${DB_NAME}, пользователь: ${DB_USER})"
"${COMPOSE[@]}" up -d postgres
wait_for_postgres
ensure_schema_migration_table

if [[ "$(table_exists zni_external_data)" != "t" ]]; then
  apply_migration_file db/migrations/048_zni_external_data.sql
fi

if [[ "$(table_exists app_notification)" != "t" ]]; then
  apply_migration_file db/migrations/049_app_notifications.sql
fi

if [[ "$(table_exists master_records)" != "t" ]]; then
  echo "==> Voice master: таблицы отсутствуют — 050…058"
  for migration in \
    db/migrations/050_voice_master.sql \
    db/migrations/052_voice_lock_session_exp.sql \
    db/migrations/053_voice_master_signature_hash.sql \
    db/migrations/055_voice_master_numeric_a_indexes.sql \
    db/migrations/056_voice_master_numeric_ids.sql \
    db/migrations/057_voice_master_rollback_numeric_a_indexes.sql \
    db/migrations/058_voice_master_prefix_index.sql
  do
    apply_migration_file "$migration"
  done
fi

if [[ "$(table_exists voice_uploads)" != "t" ]]; then
  apply_migration_file db/migrations/051_voice_registry.sql
fi

if [[ "$(table_exists org_user)" == "t" ]] \
  && [[ "$(column_exists org_user voice_only)" != "t" ]]; then
  apply_migration_file db/migrations/045_org_user_voice_only.sql
fi

if [[ "$(table_exists org_user)" == "t" ]] \
  && [[ "$(column_exists org_user voice_admin)" != "t" ]]; then
  apply_migration_file db/migrations/054_org_user_voice_admin.sql
fi

if [[ "$(table_exists zni_external_data)" == "t" ]] \
  && [[ "$(column_exists zni_external_data comment)" != "t" ]]; then
  apply_migration_file db/migrations/059_zni_external_data_comment.sql
fi

echo "==> Права alex/ivan…"
bash "$(dirname "$0")/grant-db-users.sh"

echo "==> ensure-db-schema: готово"
