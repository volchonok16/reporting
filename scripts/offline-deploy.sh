#!/usr/bin/env bash
# Деплой offline-bundle на закрытом сервере (без Docker Hub).
#
# Ветка dev / тест (my-testing.ru или APP_DOMAIN из .env):
#   sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --tunnel
#   sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --domain=example.com --tunnel
#   sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --any-host --tunnel
#
# Legacy:
#   sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --pallink --tunnel
#
# --with-nginx: HTTP nginx (без certbot); без --pallink → APP_DOMAIN / my-testing.ru
# --domain=X:   nginx под домен X
# --any-host:   nginx принимает любой Host/IP
# --pallink:    только pallink.fun
# --tunnel:     Postgres на 127.0.0.1:5432 (SSH → DBeaver)
# --with-ssl:   nginx + Let's Encrypt / corp-сертификат
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
PALLINK=0
ANY_HOST=0
NGINX_DOMAIN=""

for arg in "$@"; do
  case "$arg" in
    --tunnel) TUNNEL=1 ;;
    --with-nginx) WITH_NGINX=1 ;;
    --with-ssl) WITH_SSL=1; WITH_NGINX=1 ;;
    --pallink) PALLINK=1 ;;
    --any-host|--any) ANY_HOST=1 ;;
    --domain=*)
      NGINX_DOMAIN="${arg#--domain=}"
      ;;
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
  echo "Использование:" >&2
  echo "  sudo bash scripts/offline-deploy.sh /tmp/reporting-offline.tar --with-nginx --pallink --tunnel" >&2
  echo "Флаги: [--tunnel] [--with-nginx] [--pallink] [--with-ssl]" >&2
  echo "Bundle не найден: ${TAR:-<пусто>}" >&2
  exit 1
fi

if [[ "$WITH_NGINX" -eq 1 && "${EUID:-0}" -ne 0 ]]; then
  echo "Ошибка: --with-nginx / --with-ssl требуют root:" >&2
  echo "  sudo bash scripts/offline-deploy.sh $TAR --with-nginx --pallink --tunnel" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Ошибка: Docker не запущен (или нет прав у текущего пользователя)." >&2
  exit 1
fi

MODE=offline
[[ "$TUNNEL" -eq 1 ]] && MODE=offline-tunnel

# shellcheck source=resolve-compose.sh
source "$(dirname "$0")/resolve-compose.sh" "$MODE"

echo "==> Режим: ${MODE}"
echo "    nginx=$WITH_NGINX  pallink=$PALLINK  tunnel=$TUNNEL  ssl=$WITH_SSL"
echo "==> docker load ← ${TAR}"
docker load -i "$TAR"

# Voice SQLite (UID 10001 в образе). Права от root ломают voice-api → SSO падает.
mkdir -p voice/data
if command -v chown >/dev/null 2>&1; then
  chown -R 10001:10001 voice/data 2>/dev/null || chmod -R a+rwX voice/data 2>/dev/null || true
else
  chmod -R a+rwX voice/data 2>/dev/null || true
fi
chmod 777 voice/data 2>/dev/null || true

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

echo ""
echo "==> Ожидание Voice…"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8100/api/health >/dev/null 2>&1; then
    echo "OK voice-api: $(curl -sf http://127.0.0.1:8100/api/health)"
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "Предупреждение: voice-api не отвечает — смотрите логи ниже" >&2
    "${COMPOSE[@]}" logs --tail 80 voice-api >&2 || true
    echo "Частый фикс: sudo chown -R 10001:10001 voice/data && ${COMPOSE[*]} restart voice-api" >&2
  fi
  sleep 2
done
voice_web_probe="$(curl -sf http://127.0.0.1:3100/voice/reporting-voice.txt 2>/dev/null || true)"
if [[ "$voice_web_probe" == *voice-ok* ]]; then
  echo "OK voice-web :3100/voice/reporting-voice.txt"
else
  voice_web_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/voice/ 2>/dev/null || echo 000)"
  echo "Предупреждение: voice-web :3100/voice/ → HTTP ${voice_web_code} (ожидали voice-ok в reporting-voice.txt)" >&2
fi

# Критично: /voice/ через frontend должен отдавать voice-web, а не reporting SPA.
voice_probe="$(curl -sf http://127.0.0.1:5173/voice/reporting-voice.txt 2>/dev/null || true)"
if [[ "$voice_probe" == *voice-ok* ]]; then
  echo "OK frontend→voice: /voice/reporting-voice.txt"
else
  echo "ОШИБКА: http://127.0.0.1:5173/voice/reporting-voice.txt не вернул voice-ok." >&2
  echo "  /voice/ сейчас, скорее всего, отдаёт reporting SPA (двойной хедер в UI)." >&2
  echo "  Проверьте: docker ps | grep voice; docker exec reporting-frontend cat /etc/nginx/conf.d/default.conf | grep -A6 'location /voice'" >&2
fi

UI_URL="http://my-testing.ru/"
API_CHECK="http://my-testing.ru/api/health"
APP_DOMAIN_HINT="$(read_env APP_DOMAIN my-testing.ru)"
if [[ -n "$NGINX_DOMAIN" ]]; then
  UI_URL="http://${NGINX_DOMAIN}/"
  API_CHECK="http://${NGINX_DOMAIN}/api/health"
elif [[ "$ANY_HOST" -eq 1 ]]; then
  UI_URL="http://<host-or-ip>/"
  API_CHECK="http://127.0.0.1/api/health"
elif [[ "$PALLINK" -eq 1 ]]; then
  UI_URL="http://pallink.fun/"
  API_CHECK="http://pallink.fun/api/health"
else
  UI_URL="http://${APP_DOMAIN_HINT}/"
  API_CHECK="http://${APP_DOMAIN_HINT}/api/health"
fi

if [[ "$WITH_NGINX" -eq 1 ]]; then
  echo ""
  if [[ "$WITH_SSL" -eq 1 ]]; then
    echo "==> Nginx + SSL…"
    bash "$ROOT/deploy/setup-nginx-ssl.sh" || echo "Предупреждение: nginx/ssl не настроены полностью" >&2
  else
    echo "==> Nginx HTTP…"
    NGINX_ARGS=()
    if [[ "$PALLINK" -eq 1 ]]; then
      NGINX_ARGS+=(--pallink)
    elif [[ "$ANY_HOST" -eq 1 ]]; then
      NGINX_ARGS+=(--any-host)
    elif [[ -n "$NGINX_DOMAIN" ]]; then
      NGINX_ARGS+=(--domain="$NGINX_DOMAIN")
    else
      NGINX_ARGS+=(--domain="$APP_DOMAIN_HINT")
    fi
    bash "$ROOT/deploy/setup-nginx-http.sh" "${NGINX_ARGS[@]}" || echo "Предупреждение: nginx HTTP не настроен" >&2
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
    echo "    GET /api/health → нет ответа (проверьте: curl $API_CHECK)" >&2
  fi
  voice_code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/voice/ 2>/dev/null || echo 000)"
  echo "    GET /voice/ → HTTP ${voice_code}"
  voice_probe_host="$(curl -sf http://127.0.0.1/voice/reporting-voice.txt 2>/dev/null || true)"
  if [[ "$voice_probe_host" == *voice-ok* ]]; then
    echo "OK host nginx→voice: /voice/reporting-voice.txt"
  else
    echo "ОШИБКА: http://127.0.0.1/voice/reporting-voice.txt не вернул voice-ok (старый nginx или SPA)." >&2
  fi
fi

echo ""
echo "==> Статус контейнеров"
"${COMPOSE[@]}" ps

echo ""
echo "Готово (offline deploy, mode=${MODE})."
echo "UI:    $UI_URL"
echo "Voice: ${UI_URL}voice/"
if [[ "$TUNNEL" -eq 1 ]]; then
  echo "Postgres tunnel: 127.0.0.1:5432 (SSH → сервер → localhost:5432)"
fi
if [[ "$WITH_NGINX" -eq 0 ]]; then
  echo ""
  echo "Nginx не трогали. Полный деплой одной командой:"
  echo "  sudo bash scripts/offline-deploy.sh $TAR --with-nginx --pallink --tunnel"
fi
