#!/usr/bin/env bash
# Обновление production на сервере: git pull → Docker (prod + db-tunnel) → healthcheck.
#
#   bash scripts/deploy-prod.sh
#   bash scripts/deploy-prod.sh --no-pull      # без git pull
#   bash scripts/deploy-prod.sh --no-build   # без --build
#
# Эквивалент вручную:
#   git pull && bash scripts/compose-up.sh prod --build --tunnel
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_PULL=0
BUILD=1
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-pull) SKIP_PULL=1 ;;
    --no-build) BUILD=0 ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

if [[ "$SKIP_PULL" -eq 0 ]]; then
  echo "==> git pull"
  git pull
fi

COMPOSE_ARGS=(prod --tunnel)
[[ "$BUILD" -eq 1 ]] && COMPOSE_ARGS+=(--build)
COMPOSE_ARGS+=("${EXTRA_ARGS[@]}")

echo "==> Docker Compose (prod + db-tunnel)…"
bash "$(dirname "$0")/compose-up.sh" "${COMPOSE_ARGS[@]}"

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" prod-tunnel

echo ""
echo "==> Ожидание backend…"
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "OK: $(curl -sf http://127.0.0.1:8000/api/health)"
    break
  fi
  if [[ "$i" -eq 20 ]]; then
    echo "Предупреждение: backend не отвечает — ${COMPOSE[*]} logs backend" >&2
  fi
  sleep 2
done

echo ""
echo "==> Статус контейнеров"
"${COMPOSE[@]}" ps

if "${COMPOSE[@]}" exec -T postgres pg_isready -U reporting -d reporting >/dev/null 2>&1; then
  echo ""
  echo "PostgreSQL tunnel: 127.0.0.1:5432 (SSH → сервер → localhost:5432)"
  echo "  DBeaver: Host localhost, Port 5432, DB reporting, User alex + SSH на сервер"
else
  echo "Предупреждение: postgres не готов — ${COMPOSE[*]} logs postgres" >&2
fi

echo ""
echo "Готово."
