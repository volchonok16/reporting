#!/usr/bin/env bash
# Безопасный compose up (обход багов docker-compose 1.29 + Docker 24+:
# ContainerConfig, KeyError id в watch_events)
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-prod}"
shift || true

BUILD=0
TUNNEL=0
SERVICES=()
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --tunnel) TUNNEL=1 ;;
    *) SERVICES+=("$arg") ;;
  esac
done

if [[ "$TUNNEL" -eq 1 ]]; then
  case "$MODE" in
    prod|prod-tunnel) MODE="prod-tunnel" ;;
    *)
      echo "Предупреждение: --tunnel поддерживается только с prod (игнорируется для mode=$MODE)" >&2
      ;;
  esac
fi

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" "$MODE"

uses_compose_v1() {
  [[ "$COMPOSE_CMD" == "docker-compose" ]]
}

# shellcheck source=compose-v1-purge.sh
source "$(dirname "$0")/compose-v1-purge.sh"

purge_service() {
  local svc="$1"
  case "$svc" in
    postgres) purge_containers_by_name "reporting-postgres" ;;
    backend) purge_containers_by_name "reporting-backend" ;;
    frontend) purge_containers_by_name "reporting-frontend" ;;
    minio) purge_containers_by_name "reporting-minio" ;;
    minio-init) purge_containers_by_name "reporting-minio-init" ;;
  esac
}

if uses_compose_v1; then
  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    purge_reporting_containers_v1
  else
    echo "==> docker-compose v1: очистка выбранных сервисов…"
    for svc in "${SERVICES[@]}"; do
      purge_service "$svc"
    done
  fi
  echo "==> docker-compose v1: после purge используем up -d"
fi

ARGS=(up -d)
[[ "$BUILD" -eq 1 ]] && ARGS+=(--build)
[[ ${#SERVICES[@]} -gt 0 ]] && ARGS+=(--no-deps "${SERVICES[@]}")

echo "==> ${COMPOSE[*]} ${ARGS[*]}"
"${COMPOSE[@]}" "${ARGS[@]}"

# Права alex/ivan (в т.ч. GRANT reporting TO alex) — initdb не перезапускается на старом volume.
if [[ ${#SERVICES[@]} -eq 0 ]] || printf '%s\n' "${SERVICES[@]}" | grep -qx postgres; then
  if "${COMPOSE[@]}" exec -T postgres pg_isready -U reporting -d reporting >/dev/null 2>&1; then
    echo "==> Обновление прав alex/ivan (grant-db-users.sh)…"
    bash "$(dirname "$0")/grant-db-users.sh" || echo "Предупреждение: grant-db-users.sh не выполнен" >&2
  fi
fi
