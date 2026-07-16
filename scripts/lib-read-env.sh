# shellcheck shell=bash
# Читает KEY=value из .env в корне репозитория.
#   source scripts/lib-read-env.sh
#   value="$(read_env KEY default)"

read_env() {
  local key="$1"
  local default="${2:-}"
  local env_file="${COMPOSE_ENV_FILE:-.env}"
  if [[ -f "$env_file" ]]; then
    local line
    line="$(grep -E "^${key}=" "$env_file" | tail -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//' || true)"
    if [[ -n "$line" ]]; then
      echo "$line"
      return
    fi
  fi
  echo "$default"
}
