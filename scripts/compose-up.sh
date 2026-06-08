#!/usr/bin/env bash
# Безопасный compose up (обход багов docker-compose 1.29 + Docker 24+:
# ContainerConfig, KeyError id в watch_events)
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-prod}"
shift || true

BUILD=0
SERVICES=()
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    *) SERVICES+=("$arg") ;;
  esac
done

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" "$MODE"

uses_compose_v1() {
  [[ "$COMPOSE_CMD" == "docker-compose" ]]
}

# Удаляет все контейнеры, в имени которых есть pattern
# (reporting-frontend, ba5e359e8f7c_reporting-frontend и т.д.)
purge_containers_by_name() {
  local pattern="$1"
  local ids
  ids="$(docker ps -aq --filter "name=${pattern}" 2>/dev/null || true)"
  if [[ -n "${ids//[[:space:]]/}" ]]; then
    echo "    docker rm -f ${ids//$'\n'/ }"
    # shellcheck disable=SC2086
    docker rm -f $ids 2>/dev/null || true
  fi
}

purge_service() {
  local svc="$1"
  case "$svc" in
    postgres) purge_containers_by_name "reporting-postgres" ;;
    backend) purge_containers_by_name "reporting-backend" ;;
    frontend) purge_containers_by_name "reporting-frontend" ;;
  esac
}

if uses_compose_v1; then
  echo "==> docker-compose v1: очистка старых контейнеров…"
  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    purge_service postgres
    purge_service backend
    purge_service frontend
  else
    for svc in "${SERVICES[@]}"; do
      purge_service "$svc"
    done
  fi

  if [[ "$BUILD" -eq 1 ]]; then
    if [[ ${#SERVICES[@]} -gt 0 ]]; then
      echo "==> ${COMPOSE[*]} build ${SERVICES[*]}"
      "${COMPOSE[@]}" build "${SERVICES[@]}"
    else
      echo "==> ${COMPOSE[*]} build"
      "${COMPOSE[@]}" build
    fi
  fi

  CREATE_ARGS=(create)
  [[ ${#SERVICES[@]} -gt 0 ]] && CREATE_ARGS+=(--no-deps "${SERVICES[@]}")
  echo "==> ${COMPOSE[*]} ${CREATE_ARGS[*]}"
  "${COMPOSE[@]}" "${CREATE_ARGS[@]}"

  START_ARGS=(start)
  [[ ${#SERVICES[@]} -gt 0 ]] && START_ARGS+=("${SERVICES[@]}")
  echo "==> ${COMPOSE[*]} ${START_ARGS[*]}"
  "${COMPOSE[@]}" "${START_ARGS[@]}"
  exit 0
fi

ARGS=(up -d)
[[ "$BUILD" -eq 1 ]] && ARGS+=(--build)
[[ ${#SERVICES[@]} -gt 0 ]] && ARGS+=(--no-deps "${SERVICES[@]}")

echo "==> ${COMPOSE[*]} ${ARGS[*]}"
"${COMPOSE[@]}" "${ARGS[@]}"
