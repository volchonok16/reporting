#!/usr/bin/env bash
# Production: Docker + nginx + certbot для pallink.fun
# Запуск: sudo bash scripts/production.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/resolve-compose.sh
source "$ROOT/scripts/resolve-compose.sh" prod

echo "==> Reporting production: $ROOT"
echo "==> Compose: ${COMPOSE[*]}"

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите с sudo: sudo bash scripts/production.sh" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Ошибка: docker не установлен." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  systemctl start docker.socket docker.service 2>/dev/null || true
  sleep 2
  docker info >/dev/null 2>&1 || {
    echo "Ошибка: Docker daemon недоступен." >&2
    exit 1
  }
fi

if [[ ! -f .env ]]; then
  if [[ -f .env.production.example ]]; then
    cp .env.production.example .env
    echo "==> Создан .env из .env.production.example — смените пароли и CERTBOT_EMAIL."
  else
    echo "Предупреждение: нет .env" >&2
  fi
fi

read_env() {
  local key="$1"
  local default="${2:-}"
  if [[ -f .env ]]; then
    local line
    line="$(grep -E "^${key}=" .env | tail -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//' || true)"
    if [[ -n "$line" ]]; then
      echo "$line"
      return
    fi
  fi
  echo "$default"
}

APP_PUBLIC_URL="$(read_env APP_PUBLIC_URL https://taskatestovaya.ru)"
API_PUBLIC_URL="$(read_env API_PUBLIC_URL https://api.taskatestovaya.ru)"
CERTBOT_CERT_NAME="$(read_env CERTBOT_CERT_NAME reporting)"
CERT_DIR="/etc/letsencrypt/live/${CERTBOT_CERT_NAME}"
if [[ ! -f "$CERT_DIR/fullchain.pem" && -f /etc/letsencrypt/live/pallink.fun/fullchain.pem ]]; then
  CERT_DIR="/etc/letsencrypt/live/pallink.fun"
fi

chmod +x db/init-users.sh 2>/dev/null || true

echo "==> Nginx + SSL…"
bash "$ROOT/deploy/setup-nginx-ssl.sh"

echo "==> Docker Compose (prod)…"
bash "$ROOT/scripts/compose-up.sh" prod --build

echo ""
echo "==> Статус контейнеров"
"${COMPOSE[@]}" ps

echo ""
echo "==> Ожидание backend…"
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "OK: $(curl -sf http://127.0.0.1:8000/api/health)"
    break
  fi
  [[ "$i" -eq 20 ]] && echo "Предупреждение: backend не отвечает — ${COMPOSE[*]} logs backend" >&2
  sleep 2
done

HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: localhost' http://127.0.0.1:5173/ || echo '000')"
echo "Frontend :5173 → HTTP $HTTP_CODE"

if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
  echo ""
  echo "==> HTTPS"
  curl -sI --resolve taskatestovaya.ru:443:127.0.0.1 https://taskatestovaya.ru/ | head -3 || true
  curl -sf --resolve api.taskatestovaya.ru:443:127.0.0.1 https://api.taskatestovaya.ru/api/health && echo "" || true
  curl -sI --resolve pallink.fun:443:127.0.0.1 https://pallink.fun/ | head -3 || true
  curl -sf --resolve api.pallink.fun:443:127.0.0.1 https://api.pallink.fun/api/health && echo "" || true
fi

echo ""
echo "Готово."
echo "  Сайт: $APP_PUBLIC_URL"
echo "  API:  $API_PUBLIC_URL"
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  echo ""
  echo "Сертификат не выпущен. DNS → сервер, CERTBOT_EMAIL в .env, затем:"
  echo "  sudo bash deploy/setup-nginx-ssl.sh"
fi
