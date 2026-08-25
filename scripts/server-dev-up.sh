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
  - при «address already in use» пробует следующий порт
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

# Проверка порта: ss/lsof + реальный bind 127.0.0.1 (как в docker-compose.yml).
port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -Eq ":${p}([[:space:]]|$)"; then
      return 0
    fi
    if ss -ltn "( sport = :${p} )" 2>/dev/null | grep -q LISTEN; then
      return 0
    fi
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 - "$p" <<'PY'
import socket, sys
p = int(sys.argv[1])
for host in ("127.0.0.1", "0.0.0.0"):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, p))
    except OSError:
        sys.exit(1)
    finally:
        s.close()
sys.exit(0)
PY
    then
      return 0
    fi
  elif (echo >/dev/tcp/127.0.0.1/"$p") >/dev/null 2>&1; then
    return 0
  fi
  # Docker мог «зависнуть» на порту без LISTEN в ss
  if docker ps -a --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -Eq ":${p}->|:127\\.0\\.0\\.1:${p}->"; then
    if docker ps -a --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -Eq "reporting-postgres.*:${p}->"; then
      return 1
    fi
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

candidate_ports() {
  local current
  current="$(grep -E '^POSTGRES_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  local list=()
  # 5432 часто занят системным/чужим Postgres — пробуем его последним
  list+=(5434 5435 5436 55432 55433 5432)
  [[ -n "$current" ]] && list=("$current" "${list[@]}")
  local p seen=" "
  for p in "${list[@]}"; do
    [[ "$seen" == *" $p "* ]] && continue
    seen+=" $p "
    echo "$p"
  done
}

pick_postgres_port() {
  local p
  while read -r p; do
    if port_in_use "$p"; then
      if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -Eq "reporting-postgres.*:${p}->"; then
        echo "$p"
        return 0
      fi
      echo "    порт $p занят — пробуем следующий" >&2
      continue
    fi
    echo "$p"
    return 0
  done < <(candidate_ports)
  echo "Ошибка: не найден свободный порт для Postgres" >&2
  exit 1
}

start_postgres_on_port() {
  local p="$1"
  set_env_var POSTGRES_PORT "$p"
  echo "    пробуем POSTGRES_PORT=$p"
  docker rm -f reporting-postgres 2>/dev/null || true
  local out
  set +e
  out="$("${COMPOSE[@]}" up -d postgres 2>&1)"
  local rc=$?
  set -e
  printf '%s\n' "$out"
  if [[ $rc -ne 0 ]]; then
    if echo "$out" | grep -qiE 'address already in use|port is already allocated|bind.*5432|failed to bind host port'; then
      return 2
    fi
    return "$rc"
  fi
  return 0
}

if [[ "$RESET_DB" -eq 1 ]]; then
  echo "==> --reset-db: останавливаем стек и удаляем volume postgres…"
  "${COMPOSE[@]}" down -v 2>/dev/null || true
  docker rm -f reporting-postgres 2>/dev/null || true
  # без pipefail-падения, если volume нет
  mapfile -t _pgvols < <(docker volume ls -q 2>/dev/null | grep -E 'reporting.*pgdata|_pgdata' || true)
  for vol in "${_pgvols[@]:-}"; do
    [[ -z "${vol:-}" ]] && continue
    echo "    docker volume rm $vol"
    docker volume rm "$vol" 2>/dev/null || true
  done
fi

if [[ "${COMPOSE[0]}" == "docker-compose" ]]; then
  purge_reporting_containers_v1
fi

echo "==> Выбор POSTGRES_PORT и подъём postgres…"
PG_PORT=""
while read -r try_port; do
  if [[ -z "$PG_PORT" ]] && port_in_use "$try_port"; then
    if ! docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -Eq "reporting-postgres.*:${try_port}->"; then
      echo "    порт $try_port занят — пропуск"
      continue
    fi
  fi
  rc=0
  start_postgres_on_port "$try_port" || rc=$?
  if [[ $rc -eq 0 ]]; then
    PG_PORT="$try_port"
    break
  fi
  if [[ $rc -eq 2 ]]; then
    echo "    bind $try_port не удался (address already in use) — следующий порт"
    docker rm -f reporting-postgres 2>/dev/null || true
    continue
  fi
  echo "Ошибка: не удалось поднять postgres (rc=$rc)" >&2
  exit "$rc"
done < <(candidate_ports)

if [[ -z "$PG_PORT" ]]; then
  echo "Ошибка: все порты заняты, postgres не стартовал" >&2
  exit 1
fi
echo "    POSTGRES_PORT=$PG_PORT"

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

# schema.sql создаёт zni_board без seed — без 043 UI падает на /api/auth/defaults
board_n="$("${COMPOSE[@]}" exec -T postgres psql -U reporting -d reporting -tAc "SELECT count(*) FROM zni_board" 2>/dev/null | tr -d '[:space:]' || echo 0)"
if [[ "${board_n:-0}" == "0" ]]; then
  echo "==> Seed досок ЗНИ (043_zni_boards.sql)…"
  bash "$(dirname "$0")/migrate.sh" db/migrations/043_zni_boards.sql || echo "Предупреждение: 043_zni_boards не применена" >&2
fi

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
