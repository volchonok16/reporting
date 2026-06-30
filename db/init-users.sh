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
  --dbname "${DB_NAME}" \
  -c "GRANT ${DB_OWNER} TO alex, ivan;"

GRANTS_FILE="/docker-entrypoint-initdb.d/grants-app-users.sql"
if [[ -f "${GRANTS_FILE}" ]]; then
  psql -v ON_ERROR_STOP=1 \
    --username "${DB_OWNER}" \
    --dbname "${DB_NAME}" \
    -f "${GRANTS_FILE}"
else
  echo "Warning: ${GRANTS_FILE} not found, skipping grants" >&2
fi

echo "Users created: alex, ivan (full access on ${DB_NAME})"
