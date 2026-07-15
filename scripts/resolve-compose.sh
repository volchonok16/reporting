#!/usr/bin/env bash
# Определяет команду Compose. Использование:
#   source scripts/resolve-compose.sh dev|prod|base
#   "${COMPOSE[@]}" up -d

resolve_compose_mode="${1:-base}"

read_compose_cmd_from_env() {
  local env_file="${COMPOSE_ENV_FILE:-.env}"
  [[ -f "$env_file" ]] || return 0
  local line
  line="$(grep -E '^COMPOSE_CMD=' "$env_file" | tail -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//' || true)"
  [[ -n "$line" ]] && echo "$line"
}

pick_compose_bin() {
  local override="${COMPOSE_CMD:-}"
  if [[ -z "$override" ]]; then
    override="$(read_compose_cmd_from_env || true)"
  fi

  if [[ -n "$override" ]]; then
    if [[ "$override" == "docker-compose" ]] && docker compose version &>/dev/null 2>&1; then
      echo "Предупреждение: COMPOSE_CMD=docker-compose — лучше «docker compose» (Compose v2)." >&2
    fi
    echo "$override"
    return
  fi

  if docker compose version &>/dev/null 2>&1; then
    echo "docker compose"
    return
  fi

  if command -v docker-compose &>/dev/null; then
    echo "docker-compose"
    return
  fi

  return 1
}

compose_bin="$(pick_compose_bin)" || {
  echo "Ошибка: Docker Compose не найден." >&2
  echo "  Установите docker-compose или задайте COMPOSE_CMD=docker-compose в .env" >&2
  return 1 2>/dev/null || exit 1
}

# shellcheck disable=SC2206
COMPOSE=( $compose_bin )

case "$resolve_compose_mode" in
  dev)
    COMPOSE+=( -f docker-compose.yml -f docker-compose.dev.yml )
    ;;
  prod)
    COMPOSE+=( -f docker-compose.yml -f docker-compose.prod.yml )
    ;;
  prod-tunnel)
    COMPOSE+=( -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.db-tunnel.yml )
    ;;
  offline)
    COMPOSE+=( -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.offline.yml )
    ;;
  offline-tunnel)
    COMPOSE+=( -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.offline.yml -f docker-compose.db-tunnel.yml )
    ;;
  base)
    COMPOSE+=( -f docker-compose.yml )
    ;;
  *)
    echo "resolve-compose: неизвестный режим: $resolve_compose_mode" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

export COMPOSE_CMD="$compose_bin"
