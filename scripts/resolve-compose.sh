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
if [[ -n "${COMPOSE_ENV_FILE:-}" ]]; then
  COMPOSE+=( --env-file "$COMPOSE_ENV_FILE" )
fi

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
  corp-direct)
    COMPOSE+=( -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.offline.yml -f docker-compose.corp-direct.yml )
    ;;
  corp-direct-tunnel)
    COMPOSE+=( -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.offline.yml -f docker-compose.corp-direct.yml -f docker-compose.db-tunnel.yml )
    ;;
  base)
    COMPOSE+=( -f docker-compose.yml )
    ;;
  *)
    echo "resolve-compose: неизвестный режим: $resolve_compose_mode" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

# shellcheck source=lib-read-env.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib-read-env.sh"
read_legacy_compose_setting() {
  local key="$1" default="${2:-}" value
  if value="$(printenv "$key")"; then
    printf '%s\n' "${value:-$default}"
    return
  fi
  value="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "${COMPOSE_ENV_FILE:-.env}" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value:1}"; value="${value%%\"*}" ;;
    \'*) value="${value:1}"; value="${value%%\'*}" ;;
    *) value="${value%%[[:space:]]#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
  esac
  printf '%s\n' "${value:-$default}"
}

# Compose owns dotenv parsing, including quotes, comments and variable expansion.
if compose_module_settings="$(
  set -o pipefail
  "${COMPOSE[@]}" config --environment 2>/dev/null | sed -n \
    -e '/^REPORTING_DOGTAGS_ENABLED=/p' -e '/^COMPOSE_LOCAL_OVERRIDE=/p' -e '/^APP_PUBLIC_URL=/p'
)"; then
  reporting_dogtags_enabled="$(printf '%s\n' "$compose_module_settings" | sed -n 's/^REPORTING_DOGTAGS_ENABLED=//p')"
  compose_local_override="$(printf '%s\n' "$compose_module_settings" | sed -n 's/^COMPOSE_LOCAL_OVERRIDE=//p')"
  dogtags_public_url="$(printf '%s\n' "$compose_module_settings" | sed -n 's/^APP_PUBLIC_URL=//p')"
else
  reporting_dogtags_enabled="$(read_legacy_compose_setting REPORTING_DOGTAGS_ENABLED)"
  compose_local_override="$(read_legacy_compose_setting COMPOSE_LOCAL_OVERRIDE)"
  dogtags_public_url="$(read_legacy_compose_setting APP_PUBLIC_URL)"
fi
reporting_dogtags_enabled="${reporting_dogtags_enabled:-1}"
case "$reporting_dogtags_enabled" in
  0|1) ;;
  *)
    echo 'REPORTING_DOGTAGS_ENABLED must be 0 or 1.' >&2
    return 1 2>/dev/null || exit 1
    ;;
esac
if [[ "$reporting_dogtags_enabled" == "1" ]]; then
  if [[ -z "$dogtags_public_url" ]]; then
    case "$resolve_compose_mode" in
      dev|base) dogtags_public_url=http://localhost:5173 ;;
      *) dogtags_public_url=https://taskatestovaya.ru ;;
    esac
  fi
  # HTTP Reporting still talks to the private API through its trusted loopback origin.
  # Public HTTPS keeps its real origin and secure cookies; no HTTP origin allowlist is widened.
  case "$dogtags_public_url" in
    http://*) dogtags_public_url=http://127.0.0.1:8000 ;;
  esac
  export REPORTING_DOGTAGS_DEFAULT_ORIGIN="$dogtags_public_url"
  COMPOSE+=( -f docker-compose.dogtags.yml )
  case "$resolve_compose_mode" in
    offline*|corp-direct*) COMPOSE+=( -f docker-compose.dogtags.offline.yml ) ;;
  esac
fi
if [[ -n "$compose_local_override" ]]; then
  COMPOSE+=( -f "$compose_local_override" )
fi

export COMPOSE_CMD="$compose_bin"
