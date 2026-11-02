#!/usr/bin/env bash
# Prepares and (re)starts Simmetrika (service canvas-studio) on an Ubuntu/Debian server. Runs on the
# server as root; deploy.sh uploads and calls it. Safe to run again: every step
# checks what is already there.
#
#   remote-setup.sh <release-dir> [--domain example.com] [--www] [--redirect-from old.example.com]… [--email admin@example.com] [--closed]
#
# What it sets up:
#   - Node.js 22 LTS from nodejs.org (checksum verified) in /usr/local
#   - user "canvas", data in /var/lib/canvas-studio, app in /opt/canvas-studio
#   - systemd service "canvas-studio" (127.0.0.1:8080, sandboxed)
#   - nginx in front (gzip, WebSocket upgrade, large uploads)
#   - with --domain: HTTPS certificate from Let's Encrypt (certbot), auto-renewed;
#     --www and --redirect-from: these addresses answer with a permanent
#     redirect to the domain, keeping the path (old links keep working)
#   - firewall: only SSH, HTTP, HTTPS
#   - daily backup of the data to /var/backups/canvas-studio (14 days kept)
#   - mail settings are read from /etc/canvas-studio/env (root only, never overwritten)
set -euo pipefail

RELEASE="${1:?release dir}"
shift
DOMAIN=""
EMAIL=""
OPEN_REGISTRATION=1
REDIRECTS=()
WWW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --closed) OPEN_REGISTRATION=0; shift ;;
    --www) WWW=1; shift ;;
    --redirect-from) REDIRECTS+=("$2"); shift 2 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

APP=/opt/canvas-studio
DATA=/var/lib/canvas-studio
NODE_MAJOR=22
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Нужно запускать от root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "Системные пакеты"
# Only what is missing: an update must not wait for (or fail on) the system's own upgrades holding apt.
PKGS="curl ca-certificates xz-utils nginx ufw"
[ -n "$DOMAIN" ] && PKGS="$PKGS certbot python3-certbot-nginx"
MISSING=""
for p in $PKGS; do dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  apt-get update -qq
  apt-get install -y -qq $MISSING >/dev/null
else
  echo "уже установлены"
fi

log "Node.js $NODE_MAJOR"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ] || [ "$(node -p 'Number(process.versions.node.split(".")[1]) >= 18')" != "true" ]; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) echo "Архитектура $ARCH не поддерживается" >&2; exit 1 ;; esac
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE=$(grep -o "node-v[0-9.]*-linux-${ARCH}.tar.xz" "$TMP/SHASUMS256.txt" | head -1)
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$FILE" -C /usr/local --strip-components=1
  rm -rf "$TMP"
fi
node --version

log "Пользователь и каталоги"
id canvas >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin canvas
mkdir -p "$APP/releases" "$DATA" /var/backups/canvas-studio
chown -R canvas:canvas "$DATA"
chmod 750 "$DATA"
# Backups hold everything (password hashes, people's files, the key of link passwords): root only,
# the copies already made too — other services live on this server (BUG-158).
chmod 700 /var/backups/canvas-studio
find /var/backups/canvas-studio -type f -exec chmod 600 {} +

log "Новая версия: $RELEASE"
[ -d "$RELEASE/dist" ] || { echo "В $RELEASE нет dist/ — сборка не загрузилась" >&2; exit 1; }
chown -R root:root "$RELEASE"
# The service runs as "canvas": every file must be readable whatever mode it had on the build machine.
chmod -R a+rX,go-w "$RELEASE"
ln -sfn "$RELEASE" "$APP/current"
# Keep the five most recent releases for a quick rollback.
ls -1dt "$APP"/releases/* 2>/dev/null | tail -n +6 | xargs -r rm -rf

SECURE=0; [ -n "$DOMAIN" ] && SECURE=1
APP_URL="${DOMAIN:+https://$DOMAIN}"
[ -n "$APP_URL" ] || APP_URL="http://$(hostname -I | awk '{print $1}')"
# Mail settings and other secrets (CS_SMTP_*, CS_MAIL_FROM…) live outside the
# unit file, readable by root only; systemd reads them before dropping to "canvas".
mkdir -p "$APP/heavy"
chmod -R a+rX,go-w "$APP/heavy"
mkdir -p /etc/canvas-studio
chmod 700 /etc/canvas-studio
[ -f /etc/canvas-studio/env ] || install -m 600 /dev/null /etc/canvas-studio/env
cat > /etc/systemd/system/canvas-studio.service <<UNIT
[Unit]
Description=Simmetrika
After=network.target

[Service]
Type=simple
User=canvas
Group=canvas
WorkingDirectory=$APP/current
# The JavaScript heap is capped: V8 then collects garbage sooner instead of
# growing the process on a small server (load test: 20 files with 10 MB
# pictures, 60 people — 325 MB instead of 416 MB, the same delays).
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning --max-old-space-size=${CS_HEAP_MB:-256} $APP/current/apps/server/src/main.ts
Environment=CS_HOST=127.0.0.1
Environment=CS_PORT=8080
Environment=CS_DATA=$DATA
Environment=CS_TRUST_PROXY=1
Environment=CS_SECURE=$SECURE
# The neural network of «Удалить фон» (70 MB): deploy.sh puts it here once, outside the releases.
Environment=CS_HEAVY=$APP/heavy
Environment=CS_OPEN_REGISTRATION=$OPEN_REGISTRATION
Environment=CS_APP_URL=$APP_URL
Environment=NODE_ENV=production
EnvironmentFile=-/etc/canvas-studio/env
Restart=always
RestartSec=2
# Sandbox: the app can write only its data directory.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA
CapabilityBoundingSet=
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable canvas-studio >/dev/null
systemctl restart canvas-studio

log "nginx"
SERVER_NAME="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/canvas-studio <<NGINX
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name $SERVER_NAME;
  client_max_body_size 80m;
  gzip on;
  gzip_types text/css text/javascript application/javascript application/json application/x-ndjson image/svg+xml;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_read_timeout 1h;
  }
}
NGINX
# www and former addresses: a permanent redirect to the domain with the same path.
if [ -n "$DOMAIN" ]; then
  [ "$WWW" = 1 ] && REDIRECTS=("www.$DOMAIN" "${REDIRECTS[@]}")
  for HOST in "${REDIRECTS[@]}"; do
    cat >> /etc/nginx/sites-available/canvas-studio <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name $HOST;
  location / { return 301 https://$DOMAIN\$request_uri; }
}
NGINX
  done
fi
ln -sfn /etc/nginx/sites-available/canvas-studio /etc/nginx/sites-enabled/canvas-studio
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx || systemctl restart nginx

if [ -n "$DOMAIN" ]; then
  # One certificate per address: an existing one is kept until it nears expiry and
  # installed again (nginx config above was rewritten); a missing one is obtained.
  for HOST in "$DOMAIN" "${REDIRECTS[@]}"; do
    log "HTTPS для $HOST"
    certbot --nginx --non-interactive --agree-tos --redirect --keep-until-expiring --cert-name "$HOST" -d "$HOST" ${EMAIL:+-m "$EMAIL"} ${EMAIL:+--no-eff-email} ${EMAIL:---register-unsafely-without-email}
  done
  systemctl reload nginx
fi

log "Брандмауэр"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | head -8

log "Резервные копии данных"
cat > /etc/cron.daily/canvas-studio-backup <<'CRON'
#!/bin/sh
umask 077
tar -czf /var/backups/canvas-studio/data-$(date +%F).tgz -C /var/lib canvas-studio
find /var/backups/canvas-studio -name 'data-*.tgz' -mtime +14 -delete
CRON
chmod 755 /etc/cron.daily/canvas-studio-backup

log "Проверка"
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS http://127.0.0.1:8080/api/health && echo
systemctl --no-pager --lines=5 status canvas-studio | head -12
echo
echo "Готово: $APP_URL"
