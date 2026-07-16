#!/usr/bin/env bash
# HTTP-only nginx для закрытого контура (без certbot / Let's Encrypt).
#
#   sudo bash deploy/setup-nginx-http.sh
#
# Ставит reporting.certbot-bootstrap.conf:
#   /api/ → backend :8000
#   /    → frontend :5173 (без Host localhost — иначе 400 от nginx 1.27)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите с sudo: sudo bash deploy/setup-nginx-http.sh" >&2
  exit 1
fi

echo "==> Nginx HTTP-only ($ROOT)"

if ! command -v nginx >/dev/null 2>&1; then
  echo "==> Установка nginx…"
  if apt-get update -qq 2>/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
  else
    echo "Ошибка: apt-get update не удался (часто — сломанный zabbix repo)." >&2
    echo "  sudo mv /etc/apt/sources.list.d/*zabbix* /tmp/" >&2
    echo "  sudo apt-get update && sudo apt-get install -y nginx" >&2
    echo "  sudo bash deploy/setup-nginx-http.sh" >&2
    exit 1
  fi
fi

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/snippets
cp -f "$ROOT/deploy/nginx/snippets/proxy-common.conf" /etc/nginx/snippets/
cp -f "$ROOT/deploy/nginx/reporting.certbot-bootstrap.conf" /etc/nginx/sites-available/reporting.conf
ln -sf /etc/nginx/sites-available/reporting.conf /etc/nginx/sites-enabled/reporting.conf
rm -f /etc/nginx/sites-enabled/pallink-reporting.conf /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx 2>/dev/null || true
systemctl reload nginx

echo ""
echo "HTTP nginx готов (без SSL)."
echo "  UI:  http://taskatestovaya.ru/"
echo "  API: http://taskatestovaya.ru/api/health"
echo "  Проверка: curl -s http://127.0.0.1/api/health  или  curl -s http://taskatestovaya.ru/api/health"
