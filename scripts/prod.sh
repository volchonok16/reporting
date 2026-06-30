#!/usr/bin/env bash
# Production на сервере: git pull + docker compose (prod + tunnel) + healthcheck
# Алиас: bash scripts/up.sh prod
set -euo pipefail
exec bash "$(dirname "$0")/deploy-prod.sh" "$@"
