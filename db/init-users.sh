#!/bin/bash
set -euo pipefail

# Выполняется один раз при первом старте контейнера (docker-entrypoint-initdb.d)

ALEX_PASSWORD="${TASKHUB_ALEX_PASSWORD:-alex}"
IVAN_PASSWORD="${TASKHUB_IVAN_PASSWORD:-ivan}"
DB_OWNER="${POSTGRES_USER:-reporting}"
DB_NAME="${POSTGRES_DB:-reporting}"

psql -v ON_ERROR_STOP=1 \
  --username "${DB_OWNER}" \
  --dbname "${DB_NAME}" \
  -c "CREATE USER alex WITH PASSWORD '${ALEX_PASSWORD//\'/\'\'}';"

psql -v ON_ERROR_STOP=1 \
  --username "${DB_OWNER}" \
  --dbname "${DB_NAME}" \
  -c "CREATE USER ivan WITH PASSWORD '${IVAN_PASSWORD//\'/\'\'}';"

psql -v ON_ERROR_STOP=1 \
  --username "${DB_OWNER}" \
  --dbname "${DB_NAME}" <<EOSQL
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO alex, ivan;
GRANT ALL ON SCHEMA public TO alex, ivan;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO alex, ivan;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO alex, ivan;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO alex, ivan;

ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER} IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER} IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO alex, ivan;
ALTER DEFAULT PRIVILEGES FOR ROLE ${DB_OWNER} IN SCHEMA public
  GRANT ALL PRIVILEGES ON FUNCTIONS TO alex, ivan;

-- Для миграций DDL: SET ROLE reporting; (таблицы принадлежат reporting)
GRANT ${DB_OWNER} TO alex, ivan;
EOSQL

echo "Users created: alex, ivan (full access on ${DB_NAME})"
