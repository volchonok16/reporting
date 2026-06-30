#!/usr/bin/env bash
# Единая точка входа:
#   bash scripts/up.sh          # dev (localhost)
#   bash scripts/up.sh prod     # production: git pull + build + tunnel + healthcheck
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-dev}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$MODE" in
  dev|local)
    exec bash "$(dirname "$0")/dev.sh" "$@"
    ;;
  prod|production)
    exec bash "$(dirname "$0")/deploy-prod.sh" "$@"
    ;;
  *)
    cat >&2 <<EOF
Использование:
  bash scripts/up.sh              # локальная разработка
  bash scripts/up.sh prod         # production: git pull + docker compose + db tunnel

Опции prod (передаются в deploy-prod.sh):
  --no-pull    без git pull
  --no-build   без пересборки образов
EOF
    exit 1
    ;;
esac
