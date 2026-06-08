#!/usr/bin/env bash
# Production: Docker + nginx + certbot для pallink.fun
# Запуск: sudo bash scripts/production.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CERT_DIR="/etc/letsencrypt/live/pallink.fun"

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

APP_PUBLIC_URL="$(read_env APP_PUBLIC_URL https://pallink.fun)"
API_PUBLIC_URL="$(read_env API_PUBLIC_URL https://api.pallink.fun)"
CERTBOT_EMAIL="$(read_env CERTBOT_EMAIL "")"
CERTBOT_DOMAINS="$(read_env CERTBOT_DOMAINS pallink.fun,www.pallink.fun,api.pallink.fun)"

chmod +x db/init-users.sh 2>/dev/null || true

echo "==> Nginx (сначала — чтобы :80/:443 отвечали)…"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
fi

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/snippets
cp -f "$ROOT/deploy/nginx/snippets/proxy-common.conf" /etc/nginx/snippets/
cp -f "$ROOT/deploy/nginx/snippets/ssl-pallink.conf" /etc/nginx/snippets/

install_nginx_config() {
  if [[ -f "$CERT_DIR/fullchain.pem" && -f "$CERT_DIR/privkey.pem" ]]; then
    echo "==> SSL найден — HTTPS-конфиг."
    cp -f "$ROOT/deploy/nginx/pallink.conf" /etc/nginx/sites-available/pallink-reporting.conf
  else
    echo "==> SSL нет — HTTP bootstrap для certbot."
    cp -f "$ROOT/deploy/nginx/pallink.certbot-bootstrap.conf" /etc/nginx/sites-available/pallink-reporting.conf
  fi
  ln -sf /etc/nginx/sites-available/pallink-reporting.conf /etc/nginx/sites-enabled/pallink-reporting.conf
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx 2>/dev/null || true
  systemctl reload nginx
}

ensure_certbot() {
  if command -v certbot >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Установка certbot…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot
}

setup_certbot_auto_renewal() {
  if ! command -v certbot >/dev/null 2>&1; then
    return 0
  fi

  echo "==> Автопродление сертификата…"

  local hook_dir="/etc/letsencrypt/renewal-hooks/deploy"
  mkdir -p "$hook_dir"
  cp -f "$ROOT/deploy/certbot-renew-hook.sh" "$hook_dir/reporting-reload-nginx.sh"
  chmod +x "$hook_dir/reporting-reload-nginx.sh"
  echo "    Hook: $hook_dir/reporting-reload-nginx.sh (reload nginx после renew)"

  if systemctl list-unit-files certbot.timer &>/dev/null 2>&1; then
    systemctl enable certbot.timer 2>/dev/null || true
    systemctl start certbot.timer 2>/dev/null || true
    echo "    Timer: certbot.timer (проверка ~2 раза в сутки)"
    systemctl status certbot.timer --no-pager 2>/dev/null | head -3 || true
  else
    local cron_file="/etc/cron.d/certbot-reporting"
    if [[ ! -f /etc/cron.d/certbot ]] && [[ ! -f "$cron_file" ]]; then
      cat >"$cron_file" <<'CRON'
# Автопродление Let's Encrypt (reporting)
0 3,15 * * * root certbot -q renew --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/reporting-reload-nginx.sh
CRON
      chmod 644 "$cron_file"
      echo "    Cron: $cron_file (03:00 и 15:00 UTC)"
    else
      echo "    Cron/timer certbot уже настроен системой — hook для nginx установлен."
    fi
  fi
}

issue_certificate() {
  if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
    return 0
  fi
  if [[ -z "$CERTBOT_EMAIL" ]]; then
    echo "==> CERTBOT_EMAIL не задан — пропуск выпуска сертификата."
    echo "    Добавьте CERTBOT_EMAIL в .env и запустите скрипт снова."
    return 1
  fi

  echo "==> Certbot: выпуск сертификата…"
  ensure_certbot

  local -a domain_args=()
  local IFS=,
  for d in $CERTBOT_DOMAINS; do
    d="${d// /}"
    [[ -n "$d" ]] && domain_args+=(-d "$d")
  done

  certbot certonly --webroot -w /var/www/certbot \
    --email "$CERTBOT_EMAIL" --agree-tos --no-eff-email \
    "${domain_args[@]}"

  install_nginx_config
}

install_nginx_config

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow OpenSSH 2>/dev/null || true
  ufw allow 'Nginx Full' 2>/dev/null || ufw allow 80/tcp 443/tcp 2>/dev/null || true
fi

echo "==> Docker Compose (prod)…"
bash "$ROOT/scripts/compose-up.sh" prod --build

if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  issue_certificate || true
fi

ensure_certbot 2>/dev/null || true
setup_certbot_auto_renewal

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
  curl -sI --resolve pallink.fun:443:127.0.0.1 https://pallink.fun/ | head -3
  curl -sf --resolve api.pallink.fun:443:127.0.0.1 https://api.pallink.fun/api/health && echo ""
fi

echo ""
echo "Готово."
echo "  Сайт: $APP_PUBLIC_URL"
echo "  API:  $API_PUBLIC_URL"
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  echo ""
  echo "Сертификат не выпущен. Убедитесь, что DNS указывает на этот сервер, задайте CERTBOT_EMAIL в .env и:"
  echo "  sudo bash scripts/production.sh"
else
  echo ""
  echo "Автопродление: certbot renew (timer/cron) + reload nginx."
  echo "  Проверка: sudo certbot renew --dry-run"
fi
