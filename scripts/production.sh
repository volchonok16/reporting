#!/usr/bin/env bash
# Единый запуск production: Docker + nginx + certbot (pallink.fun)
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash deploy/apply-production.sh
