#!/usr/bin/env bash
# Проброс PostgreSQL на 127.0.0.1:5432 сервера для SSH-туннеля.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" prod-tunnel

echo "==> PostgreSQL на 127.0.0.1:5432 (только для SSH-туннеля)"
bash "$(dirname "$0")/compose-up.sh" prod-tunnel postgres

if command -v ss >/dev/null 2>&1; then
  ss -tlnp | grep 5432 || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -tln | grep 5432 || true
fi

if "${COMPOSE[@]}" exec -T postgres pg_isready -U reporting -d reporting >/dev/null 2>&1; then
  echo ""
  echo "Готово. DBeaver:"
  echo "  Главное: Host localhost, Port 5432, DB reporting, User alex"
  echo "  SSH:     Host <IP сервера>, Port 22, ваш SSH-пользователь"
else
  echo "Предупреждение: pg_isready не прошёл — см. ${COMPOSE[*]} logs postgres" >&2
  exit 1
fi
