#!/usr/bin/env bash
# Временный запуск без nginx (corp-сервер, apt не ставит nginx).
# UI: http://IP/ или http://taskatestovaya.ru/
# API: http://IP:8000/  (поддомен api.* без nginx не работает на :80)
#
#   bash scripts/corp-direct-up.sh
#   bash scripts/corp-direct-up.sh --tunnel
set -euo pipefail
cd "$(dirname "$0")/.."

TUNNEL=0
for arg in "$@"; do
  case "$arg" in
    --tunnel) TUNNEL=1 ;;
    *)
      echo "Неизвестный аргумент: $arg" >&2
      exit 1
      ;;
  esac
done

MODE=corp-direct
[[ "$TUNNEL" -eq 1 ]] && MODE=corp-direct-tunnel

# shellcheck source=compose-v1-purge.sh
source "$(dirname "$0")/resolve-compose.sh" "$MODE"
source "$(dirname "$0")/compose-v1-purge.sh"

if [[ "$COMPOSE_CMD" == "docker-compose" ]]; then
  purge_reporting_containers_v1
fi

UP_ARGS=(up -d --no-build)
if [[ "$COMPOSE_CMD" != "docker-compose" ]]; then
  UP_ARGS+=(--pull never)
fi

echo "==> ${COMPOSE[*]} ${UP_ARGS[*]}"
"${COMPOSE[@]}" "${UP_ARGS[@]}"

bash "$(dirname "$0")/grant-db-users.sh" || true

echo ""
echo "Без nginx:"
echo "  UI:  http://$(hostname -I | awk '{print $1}')/"
echo "  API: http://$(hostname -I | awk '{print $1}'):8000/api/health"
echo "  MinIO: :9000 / console :9001"
echo ""
echo "Для api.taskatestovaya.ru нужен nginx или corp reverse-proxy."
