#!/usr/bin/env bash
# Деплой offline-bundle на закрытом сервере (без Docker Hub).
#
#   bash scripts/offline-deploy.sh /tmp/reporting-offline.tar
#   bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --tunnel
#   sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx
#
# --with-nginx: HTTP nginx (без certbot) — /api/ → backend, / → frontend
# --with-ssl:   nginx + попытка Let's Encrypt / corp-сертификат (нужен root)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# shellcheck source=lib-read-env.sh
if [[ -f "$(dirname "$0")/lib-read-env.sh" ]]; then
  source "$(dirname "$0")/lib-read-env.sh"
else
  read_env() { echo "${2:-}"; }
fi

TAR=""
TUNNEL=0
WITH_NGINX=0
WITH_SSL=0

for arg in "$@"; do
  case "$arg" in
    --tunnel) TUNNEL=1 ;;
    --with-nginx) WITH_NGINX=1 ;;
    --with-ssl) WITH_SSL=1; WITH_NGINX=1 ;;
    --*)
      echo "Неизвестный аргумент: $arg" >&2
      exit 1
      ;;
    *)
      if [[ -z "$TAR" ]]; then
        TAR="$arg"
      else
        echo "Неизвестный аргумент: $arg" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$TAR" ]]; then
  TAR="$(read_env OFFLINE_BUNDLE_PATH artifacts/reporting-offline.tar)"
  if [[ ! -f "$TAR" && -f dist/reporting-offline.tar ]]; then
    TAR="dist/reporting-offline.tar"
  fi
fi

if [[ -z "$TAR" || ! -f "$TAR" ]]; then
  echo "Использование: bash scripts/offline-deploy.sh [/path/to/reporting-offline.tar] [--tunnel] [--with-nginx] [--with-ssl]" >&2
  echo "Bundle не найден: ${TAR:-<пусто>}" >&2
  exit 1
fi

if [[ "$WITH_NGINX" -eq 1 && "${EUID:-0}" -ne 0 ]]; then
  echo "Ошибка: --with-nginx / --with-ssl требуют root:" >&2
  echo "  sudo bash scripts/offline-deploy.sh $TAR --with-nginx" >&2
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

echo "==> docker load ← ${TAR}"
docker load -i "$TAR"

# shellcheck source=compose-v1-purge.sh
source "$(dirname "$0")/compose-v1-purge.sh"
if [[ "$COMPOSE_CMD" == "docker-compose" ]]; then
  purge_reporting_containers_v1
  echo "==> docker-compose v1: после purge — up -d --no-build"
fi

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

if [[ "$WITH_NGINX" -eq 1 ]]; then
  echo ""
  if [[ "$WITH_SSL" -eq 1 ]]; then
    echo "==> Nginx + SSL…"
    bash "$ROOT/deploy/setup-nginx-ssl.sh" || echo "Предупреждение: nginx/ssl не настроены полностью" >&2
  else
    echo "==> Nginx HTTP (закрытый контур, без certbot)…"
    bash "$ROOT/deploy/setup-nginx-http.sh" || echo "Предупреждение: nginx HTTP не настроен" >&2
  fi

  echo ""
  echo "==> Проверка через nginx…"
  sleep 1
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/ 2>/dev/null || echo 000)"
  echo "    GET / → HTTP ${code}"
  health="$(curl -sf http://127.0.0.1/api/health 2>/dev/null || true)"
  if [[ -n "$health" ]]; then
    echo "    GET /api/health → ${health}"
  else
    echo "    GET /api/health → нет ответа (проверьте: curl http://taskatestovaya.ru/api/health)" >&2
  fi
fi

echo ""
echo "==> Статус контейнеров"
"${COMPOSE[@]}" ps

echo ""
echo "Готово (offline deploy)."
if [[ "$WITH_NGINX" -eq 0 ]]; then
  echo "Nginx не трогали. Для HTTP на corp (рекомендуется):"
  echo "  sudo bash scripts/offline-deploy.sh $TAR --with-nginx"
  echo "С SSL (corp-сертификат или LE):"
  echo "  sudo bash scripts/offline-deploy.sh $TAR --with-ssl"
fi
echo "UI: http://taskatestovaya.ru/  (не https, пока нет сертификата)"
