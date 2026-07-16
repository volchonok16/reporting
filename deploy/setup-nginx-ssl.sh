#!/usr/bin/env bash
# Установка nginx + (опционально) Let's Encrypt certbot.
# Вызывается из production.sh и offline-deploy.sh --with-nginx.
#
#   sudo bash deploy/setup-nginx-ssl.sh
#
# Требует root. Читает .env: CERTBOT_EMAIL, CERTBOT_DOMAINS, APP_PUBLIC_URL.
# Конфиги сейчас заточены под pallink.fun (deploy/nginx/*).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CERT_DIR="/etc/letsencrypt/live/pallink.fun"

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите с sudo: sudo bash deploy/setup-nginx-ssl.sh" >&2
  exit 1
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

echo "==> Nginx + SSL ($ROOT)"
echo "    UI:  $APP_PUBLIC_URL"
echo "    API: $API_PUBLIC_URL"

if ! command -v nginx >/dev/null 2>&1; then
  echo "==> Установка nginx…"
  if ! apt-get update -qq; then
    echo "Предупреждение: apt-get update не удался (нет интернета?). Установите nginx вручную." >&2
    exit 1
  fi
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
    echo "==> SSL нет — HTTP bootstrap (для certbot / внутренняя сеть)."
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
  if ! apt-get update -qq; then
    echo "Предупреждение: не удалось установить certbot (нет apt/интернета)." >&2
    return 1
  fi
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
  echo "    Hook: $hook_dir/reporting-reload-nginx.sh"

  if systemctl list-unit-files certbot.timer &>/dev/null 2>&1; then
    systemctl enable certbot.timer 2>/dev/null || true
    systemctl start certbot.timer 2>/dev/null || true
    echo "    Timer: certbot.timer"
  else
    local cron_file="/etc/cron.d/certbot-reporting"
    if [[ ! -f /etc/cron.d/certbot ]] && [[ ! -f "$cron_file" ]]; then
      cat >"$cron_file" <<'CRON'
# Автопродление Let's Encrypt (reporting)
0 3,15 * * * root certbot -q renew --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/reporting-reload-nginx.sh
CRON
      chmod 644 "$cron_file"
      echo "    Cron: $cron_file"
    fi
  fi
}

issue_certificate() {
  if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
    echo "==> Сертификат уже есть: $CERT_DIR"
    return 0
  fi
  if [[ -z "$CERTBOT_EMAIL" ]]; then
    echo "==> CERTBOT_EMAIL не задан — пропуск Let's Encrypt."
    echo "    Для выпуска: добавьте CERTBOT_EMAIL в .env и запустите снова."
    return 1
  fi

  echo "==> Certbot: выпуск сертификата ($CERTBOT_DOMAINS)…"
  ensure_certbot || return 1

  local -a domain_args=()
  local IFS=,
  for d in $CERTBOT_DOMAINS; do
    d="${d// /}"
    [[ -n "$d" ]] && domain_args+=(-d "$d")
  done

  if ! certbot certonly --webroot -w /var/www/certbot \
    --email "$CERTBOT_EMAIL" --agree-tos --no-eff-email \
    "${domain_args[@]}"; then
    echo "Предупреждение: certbot не выпустил сертификат." >&2
    echo "  Нужны: публичный DNS → этот сервер, порты 80/443, интернет до Let's Encrypt." >&2
    echo "  На закрытом corp-сервере используйте корпоративный сертификат вручную." >&2
    return 1
  fi

  install_nginx_config
}

install_nginx_config

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow OpenSSH 2>/dev/null || true
  ufw allow 'Nginx Full' 2>/dev/null || ufw allow 80/tcp 443/tcp 2>/dev/null || true
fi

if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  issue_certificate || true
fi

ensure_certbot 2>/dev/null || true
setup_certbot_auto_renewal

echo ""
if [[ -f "$CERT_DIR/fullchain.pem" ]]; then
  echo "HTTPS готов: $APP_PUBLIC_URL / $API_PUBLIC_URL"
  echo "Проверка renew: sudo certbot renew --dry-run"
else
  echo "Nginx на HTTP (bootstrap). HTTPS пока нет."
  echo "  Let's Encrypt: CERTBOT_EMAIL + DNS + интернет → sudo bash deploy/setup-nginx-ssl.sh"
  echo "  Corp-сертификат: положите fullchain/privkey в $CERT_DIR и снова запустите скрипт."
fi
