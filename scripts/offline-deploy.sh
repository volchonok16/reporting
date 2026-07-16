#!/usr/bin/env bash
# Деплой offline-bundle на закрытом сервере (без Docker Hub).
#
#   bash scripts/offline-deploy.sh /tmp/reporting-offline.tar
#   bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --tunnel
#   sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --tunnel --with-nginx
#
# --with-nginx: ставит/настраивает nginx + пытается Let's Encrypt (нужен root).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TAR="${1:-}"
TUNNEL=0
WITH_NGINX=0
shift || true
for arg in "$@"; do
  case "$arg" in
    --tunnel) TUNNEL=1 ;;
    --with-nginx) WITH_NGINX=1 ;;
    *)
      echo "Неизвестный аргумент: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TAR" || ! -f "$TAR" ]]; then
  echo "Использование: bash scripts/offline-deploy.sh /path/to/reporting-offline.tar [--tunnel] [--with-nginx]" >&2
  exit 1
fi

if [[ "$WITH_NGINX" -eq 1 && "${EUID:-0}" -ne 0 ]]; then
  echo "Ошибка: --with-nginx требует root: sudo bash scripts/offline-deploy.sh … --with-nginx" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Ошибка: Docker не запущен." >&2
  exit 1
fi

MODE=offline
[[ "$TUNNEL" -eq 1 ]] && MODE=offline-tunnel

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" "$MODE"

if [[ "$WITH_NGINX" -eq 1 ]]; then
  echo "==> Nginx + SSL…"
  bash "$ROOT/deploy/setup-nginx-ssl.sh" || echo "Предупреждение: nginx/ssl не настроены полностью" >&2
fi

echo "==> docker load ← ${TAR}"
docker load -i "$TAR"

# Compose v1 (docker-compose) не знает --pull never / pull_policy.
# v2 (docker compose): --pull never — не ходить в Docker Hub.
UP_ARGS=(up -d --no-build)
if [[ "$COMPOSE_CMD" != "docker-compose" ]]; then
  UP_ARGS+=(--pull never)
fi

echo "==> ${COMPOSE[*]} ${UP_ARGS[*]}"
"${COMPOSE[@]}" "${UP_ARGS[@]}"

echo ""
echo "==> Права БД для alex/ivan…"
bash "$(dirname "$0")/grant-db-users.sh" || echo "Предупреждение: grant-db-users.sh не выполнен" >&2

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

echo ""
echo "Готово (offline deploy)."
if [[ "$WITH_NGINX" -eq 0 ]]; then
  echo "Nginx/SSL не трогали. Чтобы настроить:"
  echo "  sudo bash scripts/offline-deploy.sh $TAR --tunnel --with-nginx"
  echo "  или отдельно: sudo bash deploy/setup-nginx-ssl.sh"
fi
