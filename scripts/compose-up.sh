#!/usr/bin/env bash
# Безопасный compose up (обход KeyError ContainerConfig на docker-compose 1.29 + Docker 24+)
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

compose_v1_containerconfig_bug() {
  [[ "$COMPOSE_CMD" == "docker-compose" ]] || return 1
  docker-compose --version 2>/dev/null | grep -qE 'docker-compose version 1\.(2[0-9]|29)\.'
}

remove_service_container() {
  local svc="$1"
  case "$svc" in
    postgres) docker rm -f reporting-postgres 2>/dev/null || true ;;
    backend) docker rm -f reporting-backend 2>/dev/null || true ;;
    frontend) docker rm -f reporting-frontend 2>/dev/null || true ;;
  esac
}

if compose_v1_containerconfig_bug; then
  echo "==> docker-compose 1.29: удаляем старые контейнеры (ContainerConfig workaround)…"
  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    remove_service_container frontend
    remove_service_container backend
    # postgres не трогаем без явного запроса — данные в volume
  else
    for svc in "${SERVICES[@]}"; do
      remove_service_container "$svc"
    done
  fi
fi

ARGS=(up -d)
[[ "$BUILD" -eq 1 ]] && ARGS+=(--build)
[[ ${#SERVICES[@]} -gt 0 ]] && ARGS+=("${SERVICES[@]}")

echo "==> ${COMPOSE[*]} ${ARGS[*]}"
"${COMPOSE[@]}" "${ARGS[@]}"
