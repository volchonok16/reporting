#!/usr/bin/env bash
# HTTP-only nginx (без certbot / Let's Encrypt).
#
#   sudo bash deploy/setup-nginx-http.sh           # taskatestovaya.ru + pallink (bootstrap)
#   sudo bash deploy/setup-nginx-http.sh --pallink # только pallink.fun
#
#   /api/ → backend :8000
#   /    → frontend :5173 (без Host localhost — иначе 400 от nginx 1.27)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SITE=bootstrap
for arg in "$@"; do
  case "$arg" in
    --pallink) SITE=pallink ;;
    --bootstrap|--corp) SITE=bootstrap ;;
    *)
      echo "Неизвестный аргумент: $arg (ожидается --pallink)" >&2
      exit 1
      ;;
  esac
done

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите с sudo: sudo bash deploy/setup-nginx-http.sh [--pallink]" >&2
  exit 1
fi

if [[ "$SITE" == "pallink" ]]; then
  CONF_SRC="$ROOT/deploy/nginx/pallink-http.conf"
  UI_HINT="http://pallink.fun/"
  API_HINT="http://pallink.fun/api/health"
else
  CONF_SRC="$ROOT/deploy/nginx/reporting.certbot-bootstrap.conf"
  UI_HINT="http://taskatestovaya.ru/"
  API_HINT="http://taskatestovaya.ru/api/health"
fi

echo "==> Nginx HTTP-only ($SITE) ← $CONF_SRC"

if ! command -v nginx >/dev/null 2>&1; then
  echo "==> Установка nginx…"
  if apt-get update -qq 2>/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
  else
    echo "Ошибка: apt-get update не удался (часто — сломанный zabbix repo)." >&2
    echo "  sudo mv /etc/apt/sources.list.d/*zabbix* /tmp/" >&2
    echo "  sudo apt-get update && sudo apt-get install -y nginx" >&2
    echo "  sudo bash deploy/setup-nginx-http.sh --pallink   # или без флага для corp bootstrap" >&2
    exit 1
  fi
fi

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/snippets
cp -f "$ROOT/deploy/nginx/snippets/proxy-common.conf" /etc/nginx/snippets/
cp -f "$CONF_SRC" /etc/nginx/sites-available/reporting.conf
ln -sf /etc/nginx/sites-available/reporting.conf /etc/nginx/sites-enabled/reporting.conf
rm -f /etc/nginx/sites-enabled/pallink-reporting.conf /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx 2>/dev/null || true
systemctl reload nginx

echo ""
echo "HTTP nginx готов (без SSL, site=$SITE)."
echo "  UI:  $UI_HINT"
echo "  API: $API_HINT"
echo "  Проверка: curl -s http://127.0.0.1/api/health"
