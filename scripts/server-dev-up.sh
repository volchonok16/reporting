#!/usr/bin/env bash
# Поднять полный dev-стек на сервере (пустой или после сбоя портов).
# Использование:
#   bash scripts/server-dev-up.sh
#   bash scripts/server-dev-up.sh --no-build
#   bash scripts/server-dev-up.sh --reset-db   # удалить volume postgres (данные БД сотрутся)
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD=1
RESET_DB=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --reset-db) RESET_DB=1 ;;
    -h|--help)
      cat <<'EOF'
Поднимает postgres → backend/frontend/voice/minio на сервере.

  bash scripts/server-dev-up.sh
  bash scripts/server-dev-up.sh --no-build
  bash scripts/server-dev-up.sh --reset-db

Автоматически:
  - создаёт .env из .env.example при отсутствии
  - выбирает свободный POSTGRES_PORT (5432 → 5434 → 5435 → 55432 …)
  - ждёт healthy у postgres
  - поднимает остальной стек
  - печатает curl-проверки
EOF
      exit 0
      ;;
    *)
      echo "Неизвестный аргумент: $arg (см. --help)" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "==> Создан .env из .env.example"
fi

chmod +x db/init-users.sh 2>/dev/null || true

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" dev
# shellcheck source=compose-v1-purge.sh
source "$(dirname "$0")/compose-v1-purge.sh"

port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -lptn 2>/dev/null | grep -Eq ":${p}\\b" && return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  # fallback: попытка bind через bash (без docker)
  if (echo >/dev/tcp/127.0.0.1/"$p") >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

set_env_var() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    printf '\n%s=%s\n' "$key" "$val" >> .env
  fi
}

pick_postgres_port() {
  local candidates=(5432 5434 5435 5436 55432 55433)
  local current
  current="$(grep -E '^POSTGRES_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  if [[ -n "$current" ]]; then
    candidates=("$current" "${candidates[@]}")
  fi
  local p seen=""
  for p in "${candidates[@]}"; do
    [[ " $seen " == *" $p "* ]] && continue
    seen+=" $p"
    if port_in_use "$p"; then
      # занят нашим reporting-postgres — можно оставить
      if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -q "reporting-postgres.*:${p}->"; then
        echo "$p"
        return 0
      fi
      echo "    порт $p занят — пробуем следующий" >&2
      continue
    fi
    echo "$p"
    return 0
  done
  echo "Ошибка: не найден свободный порт для Postgres (${candidates[*]})" >&2
  exit 1
}

echo "==> Выбор POSTGRES_PORT…"
PG_PORT="$(pick_postgres_port)"
set_env_var POSTGRES_PORT "$PG_PORT"
echo "    POSTGRES_PORT=$PG_PORT"

if [[ "$RESET_DB" -eq 1 ]]; then
  echo "==> --reset-db: останавливаем стек и удаляем volume postgres…"
  "${COMPOSE[@]}" down -v 2>/dev/null || true
  docker rm -f reporting-postgres 2>/dev/null || true
  docker volume ls -q | grep -E 'reporting.*pgdata|_pgdata' | while read -r vol; do
    echo "    docker volume rm $vol"
    docker volume rm "$vol" 2>/dev/null || true
  done
fi

if [[ "${COMPOSE[0]}" == "docker-compose" ]]; then
  purge_reporting_containers_v1
fi

echo "==> Подъём postgres…"
docker rm -f reporting-postgres 2>/dev/null || true
"${COMPOSE[@]}" up -d postgres

echo "==> Ожидание healthy (postgres)…"
ok=0
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T postgres pg_isready -U reporting -d reporting >/dev/null 2>&1; then
    ok=1
    echo "    postgres ready (${i}s)"
    break
  fi
  st="$(docker inspect -f '{{.State.Status}}/{{.State.ExitCode}}' reporting-postgres 2>/dev/null || echo missing)"
  if [[ "$st" == exited/* ]] || [[ "$st" == dead/* ]]; then
    echo "Ошибка: reporting-postgres = $st" >&2
    "${COMPOSE[@]}" logs --tail=80 postgres || true
    exit 1
  fi
  sleep 1
done
if [[ "$ok" -ne 1 ]]; then
  echo "Ошибка: postgres не стал ready за 60с" >&2
  "${COMPOSE[@]}" logs --tail=80 postgres || true
  exit 1
fi

echo "==> Права alex/ivan…"
bash "$(dirname "$0")/grant-db-users.sh" || echo "Предупреждение: grant-db-users.sh не выполнен" >&2

ARGS=(up -d)
[[ "$BUILD" -eq 1 ]] && ARGS+=(--build)
echo "==> ${COMPOSE[*]} ${ARGS[*]}"
"${COMPOSE[@]}" "${ARGS[@]}"

echo "==> Статус:"
"${COMPOSE[@]}" ps

echo ""
echo "==> Проверки:"
curl -sS -o /dev/null -w 'frontend http://127.0.0.1:5173/  → %{http_code}\n' http://127.0.0.1:5173/ || echo 'frontend → fail'
curl -sS -o /dev/null -w 'backend  http://127.0.0.1:8000/api/health → %{http_code}\n' http://127.0.0.1:8000/api/health || echo 'backend → fail'

echo ""
echo "Готово. Postgres на хосте: 127.0.0.1:${PG_PORT} (внутри Docker всегда postgres:5432)."
echo "UI: http://127.0.0.1:5173  |  API: http://127.0.0.1:8000/api/health"
echo "Nginx (домен): sudo bash deploy/setup-nginx-http.sh"
