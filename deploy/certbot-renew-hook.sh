#!/bin/sh
# Deploy-hook certbot: после успешного renew перезагрузить nginx.
set -e
if command -v nginx >/dev/null 2>&1; then
  nginx -t
  systemctl reload nginx
fi
