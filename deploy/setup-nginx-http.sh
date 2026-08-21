#!/usr/bin/env bash
# HTTP-only nginx (без certbot / Let's Encrypt).
#
# Ветка dev / тестовый стенд:
#   sudo bash deploy/setup-nginx-http.sh                  # my-testing.ru (или APP_DOMAIN из .env)
#   sudo bash deploy/setup-nginx-http.sh --domain example.com
#   sudo bash deploy/setup-nginx-http.sh --any-host       # любой Host/IP/домен
#
# Legacy:
#   sudo bash deploy/setup-nginx-http.sh --pallink        # pallink.fun
#   sudo bash deploy/setup-nginx-http.sh --bootstrap      # taskatestovaya.ru + pallink
#
#   /api/ → backend :8000
#   /    → frontend :5173 (без Host localhost — иначе 400 от nginx 1.27)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

read_env() {
  local key="$1" default="${2:-}"
  if [[ -f "$ROOT/.env" ]]; then
    local line
    line="$(grep -E "^${key}=" "$ROOT/.env" 2>/dev/null | tail -1 || true)"
    if [[ -n "$line" ]]; then
      echo "${line#*=}" | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
      return
    fi
  fi
  echo "$default"
}

SITE=dev
DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --pallink) SITE=pallink ;;
    --bootstrap|--corp) SITE=bootstrap ;;
    --any-host|--any) SITE=any-host ;;
    --domain=*)
      SITE=dev
      DOMAIN="${arg#--domain=}"
      ;;
    --domain)
      echo "Укажите домен: --domain=example.com" >&2
      exit 1
      ;;
    --dev)
      SITE=dev
      ;;
    *)
      if [[ "$arg" == --* ]]; then
        echo "Неизвестный аргумент: $arg" >&2
        echo "Ожидается: [--domain=HOST] [--any-host] [--pallink] [--bootstrap]" >&2
        exit 1
      fi
      # Позиционный домен: setup-nginx-http.sh my-testing.ru
      SITE=dev
      DOMAIN="$arg"
      ;;
  esac
done

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите с sudo: sudo bash deploy/setup-nginx-http.sh [--domain=HOST|--any-host|--pallink]" >&2
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  DOMAIN="$(read_env APP_DOMAIN "")"
  if [[ -z "$DOMAIN" ]]; then
    DOMAIN="$(read_env NGINX_DOMAIN "")"
  fi
  if [[ -z "$DOMAIN" ]]; then
    # APP_PUBLIC_URL=http://my-testing.ru → my-testing.ru
    local_url="$(read_env APP_PUBLIC_URL "")"
    if [[ -n "$local_url" ]]; then
      DOMAIN="$(echo "$local_url" | sed -E 's|^https?://||; s|/.*||; s|:.*||')"
    fi
  fi
fi
DOMAIN="${DOMAIN:-my-testing.ru}"
DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%%/*}"

case "$SITE" in
  any-host)
    CONF_SRC="$ROOT/deploy/nginx/dev-any-host.conf"
    UI_HINT="http://<любой-хост-или-IP>/"
    API_HINT="http://<любой-хост-или-IP>/api/health"
    ;;
  pallink)
    CONF_SRC="$ROOT/deploy/nginx/pallink-http.conf"
    UI_HINT="http://pallink.fun/"
    API_HINT="http://pallink.fun/api/health"
    ;;
  bootstrap)
    CONF_SRC="$ROOT/deploy/nginx/reporting.certbot-bootstrap.conf"
    UI_HINT="http://taskatestovaya.ru/"
    API_HINT="http://taskatestovaya.ru/api/health"
    ;;
  *)
    SITE=dev
    CONF_SRC="$ROOT/deploy/nginx/dev-http.conf.template"
    UI_HINT="http://${DOMAIN}/"
    API_HINT="http://${DOMAIN}/api/health"
    ;;
esac

echo "==> Nginx HTTP-only ($SITE${DOMAIN:+, domain=$DOMAIN}) ← $CONF_SRC"

if ! command -v nginx >/dev/null 2>&1; then
  echo "==> Установка nginx…"
  if apt-get update -qq 2>/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
  else
    echo "Ошибка: apt-get update не удался (часто — сломанный zabbix repo)." >&2
    echo "  sudo mv /etc/apt/sources.list.d/*zabbix* /tmp/" >&2
    echo "  sudo apt-get update && sudo apt-get install -y nginx" >&2
    echo "  sudo bash deploy/setup-nginx-http.sh --domain=my-testing.ru" >&2
    exit 1
  fi
fi

mkdir -p /var/www/certbot
mkdir -p /etc/nginx/snippets
cp -f "$ROOT/deploy/nginx/snippets/proxy-common.conf" /etc/nginx/snippets/
cp -f "$ROOT/deploy/nginx/snippets/voice-proxy.conf" /etc/nginx/snippets/

if [[ "$SITE" == "dev" ]]; then
  sed "s/__DOMAIN__/${DOMAIN}/g" "$CONF_SRC" > /etc/nginx/sites-available/reporting.conf
else
  cp -f "$CONF_SRC" /etc/nginx/sites-available/reporting.conf
fi

ln -sf /etc/nginx/sites-available/reporting.conf /etc/nginx/sites-enabled/reporting.conf
rm -f /etc/nginx/sites-enabled/pallink-reporting.conf /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx 2>/dev/null || true
systemctl reload nginx

echo ""
echo "HTTP nginx готов (без SSL, site=$SITE)."
echo "  UI:  $UI_HINT"
echo "  API: $API_HINT"
echo "  Voice: ${UI_HINT%/}/voice/"
if [[ "$SITE" == "dev" ]]; then
  echo "  Домен: $DOMAIN (www / api / minio / minio-console.$DOMAIN)"
  echo "  Другой домен: sudo bash deploy/setup-nginx-http.sh --domain=example.com"
  echo "  Любой Host:   sudo bash deploy/setup-nginx-http.sh --any-host"
fi
echo "  Проверка: curl -s http://127.0.0.1/api/health"
